// Cursor runs over `agent acp` (JSON-RPC / ACP). These tests pin permission,
// ask_question, env scrubbing, and spawn args against a fake agent — no live
// Cursor login on CI.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAcpClient } from '../main/acp.mts';
import { createCursorWorker } from '../main/cursor-worker.mts';
import { createCursorSpool } from '../main/cursor-spool.mts';
import { harnessFor } from '../main/harnesses.mts';
import { harnessDefinition } from '../shared/harness-definitions.mts';
import { cursorHarnessEnabled, ENGINE_IDS } from '../shared/engines.mts';
import { fakeCursorAgent } from './helpers/fake-acp-agent.mts';

const settle = async (child: ReturnType<typeof fakeCursorAgent>, method: string, result: unknown) => {
  await vi.waitFor(() => expect(child.lastCall(method)).toBeTruthy());
  child.reply((child.lastCall(method) as { id: unknown }).id, result);
};

describe('Cursor harness speaks ACP', () => {
  it('is registered but not offered until cursorHarness is true', () => {
    expect(harnessFor('cursor').id).toBe('cursor');
    expect(harnessDefinition('cursor')?.admitted).toBe(false);
    expect(ENGINE_IDS).not.toContain('cursor');
    expect(cursorHarnessEnabled({ cursorHarness: true })).toBe(true);
    expect(cursorHarnessEnabled({})).toBe(false);
  });

  it('strips Cursor and provider keys from the worker environment', () => {
    const input = {
      PATH: '/bin', HOME: '/home',
      CURSOR_API_KEY: 'secret', CURSOR_CONFIG_DIR: '/wrong',
      ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret',
    };
    expect(harnessFor('cursor').workerEnv(input)).toEqual({ PATH: '/bin', HOME: '/home' });
    expect(input.CURSOR_API_KEY).toBe('secret');
  });

  it('answers cursor/ask_question with a nested outcome envelope', async () => {
    const child = fakeCursorAgent();
    createAcpClient({
      transport: child,
      onExtension: async ({ method }) => {
        if (method !== 'cursor/ask_question') throw Error(method);
        return { outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }] } };
      },
    });
    child.say({
      jsonrpc: '2.0', id: 3, method: 'cursor/ask_question',
      params: { toolCallId: 'c1', questions: [{ id: 'q1', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] }] },
    });
    await vi.waitFor(() => expect(child.sent.find((m: { id: unknown }) => m.id === 3)).toBeTruthy());
    const response = child.sent.find((m: { id: unknown }) => m.id === 3) as { result: unknown };
    expect(response.result).toEqual({
      outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }] },
    });
  });

  it('feeds ask answers from the approvals spool into the agent', async () => {
    const child = fakeCursorAgent();
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-spool-'));
    const spool = createCursorSpool({ storeRoot });
    const scope = spool.scope({ product: 'alpha', item: 'w-1' });

    const worker = createCursorWorker({
      bin: '/ignored',
      cwd: '/task',
      env: { PATH: '/bin', CURSOR_API_KEY: 'x' },
      plan: { prompt: 'do work', resumeId: null, mcpServers: [] },
      spool: scope,
      transport: child,
    });

    const run = (async () => {
      await settle(child, 'initialize', { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      await settle(child, 'authenticate', {});
      await settle(child, 'session/new', { sessionId: 'sess-1' });
      const turn = worker.done;
      await vi.waitFor(() => expect(child.lastCall('session/prompt')).toBeTruthy());
      child.say({
        jsonrpc: '2.0', id: 11, method: 'cursor/ask_question',
        params: {
          toolCallId: 'ask-1',
          questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] }],
        },
      });
      await vi.waitFor(() => {
        const dir = path.join(storeRoot, '.approvals');
        return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.request.json'));
      });
      spool.settle('ask-1', true, JSON.stringify({ answers: [{ questionId: 'q1', selectedOptionIds: ['x'] }] }));
      await vi.waitFor(() => expect(child.sent.find((m: { id: unknown }) => m.id === 11)).toBeTruthy());
      expect((child.sent.find((m: { id: unknown }) => m.id === 11) as { result: unknown }).result).toEqual({
        outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['x'] }] },
      });
      await settle(child, 'session/prompt', { stopReason: 'end_turn' });
      await turn;
    })();

    await run;
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it('spawn uses agent acp in the task folder, not --worktree', () => {
    const source = fs.readFileSync(new URL('../main/cursor-worker.mts', import.meta.url), 'utf8');
    expect(source).toMatch(/\['acp'\]/);
    expect(source).not.toMatch(/--worktree/);
    expect(source).not.toMatch(/--force\b/);
  });
});
