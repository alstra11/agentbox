import { EventEmitter } from 'node:events';
import type { EventEmitter as EE } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createAcpClient } from './acp.mts';
import type { CursorAskParams } from './cursor.mts';
import type { createCursorSpool } from './cursor-spool.mts';

export interface CursorWorkerPlan {
  prompt?: string;
  resumeId?: string | null;
  model?: string | null;
  mcpServers?: unknown[];
}

export interface CursorWorker extends EventEmitter {
  stderr: EventEmitter;
  stdout: EventEmitter;
  sessionId: string | null;
  child: ChildProcess | null;
  error?: unknown;
  kill(): void;
  done: Promise<void>;
}

export interface CursorWorkerOptions {
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  plan: CursorWorkerPlan;
  spool: ReturnType<ReturnType<typeof createCursorSpool>['scope']>;
  transport?: EE & { stdin: { write: (line: string, cb?: () => void) => unknown; end(): unknown }; stdout?: EE; stderr?: EE; kill?(): unknown };
}

export function createCursorWorker({ bin, cwd, env, plan, spool, transport }: CursorWorkerOptions): CursorWorker {
  const child = transport ?? spawn(bin, ['acp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const worker = new EventEmitter() as CursorWorker;
  worker.stderr = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.sessionId = plan.resumeId ?? null;
  worker.child = child as ChildProcess;

  child.stderr?.on?.('data', chunk => worker.stderr.emit('data', chunk.toString()));

  const client = createAcpClient({
    transport: child,
    clientInfo: { name: 'agentbox', version: '1.0.0' },
    onNotification: (method, params) => worker.emit('event', method, params),
    onPermission: request => spool.permission(request),
    onExtension: async ({ method, params }) => {
      if (method === 'cursor/ask_question') {
        const answered = await spool.ask(params as CursorAskParams);
        return { outcome: answered };
      }
      if (method === 'cursor/create_plan') {
        return spool.planAccepted();
      }
      throw Error(`${method} is not supported by this client`);
    },
  });

  let ended = false;
  const stop = () => {
    if (ended) return;
    ended = true;
    try { client.close('stopped'); } catch { /* gone */ }
    try { child.kill?.(); } catch { /* gone */ }
  };
  worker.kill = stop;

  const run = (async () => {
    try {
      await client.initialize();
      try { await client.authenticate('cursor_login'); } catch { /* already signed in */ }
      if (worker.sessionId && client.can('loadSession')) {
        await client.loadSession({ sessionId: worker.sessionId, cwd, mcpServers: plan.mcpServers ?? [] });
      } else {
        const { sessionId } = await client.newSession({ cwd, mcpServers: plan.mcpServers ?? [] }) as { sessionId?: string };
        worker.sessionId = sessionId ?? null;
      }
      const prompt = [{ type: 'text', text: String(plan.prompt ?? '') }];
      const result = await client.prompt({ sessionId: worker.sessionId!, text: String(plan.prompt ?? ''), blocks: prompt });
      if (result && typeof result === 'object' && (result as { stopReason?: string }).stopReason === 'cancelled') {
        worker.error = 'cancelled';
      }
    } catch (error) {
      worker.error = (error as Error).message ?? error;
      worker.stderr.emit('data', String(worker.error));
    } finally {
      stop();
      worker.emit('exit', worker.error ? 1 : 0, null);
    }
  })();

  worker.done = run;
  return worker;
}
