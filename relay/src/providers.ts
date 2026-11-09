// One interface for a cloud agent. Cursor is the one that runs.
// openai-agents, codex-cli and claude-managed are named so a later provider
// can take the same calls; they do not run yet.

export class ProviderError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export interface CreateAgentInput {
  prompt: string;
  repoUrl: string;
  startingRef?: string;
  model?: string;
  autoCreatePR: boolean;
  name?: string;
}

export interface FollowUpResult {
  runId: string | null;
  queued: boolean;
}

export interface AgentRunView {
  id: string;
  status: string;
  result?: string;
  branch: string | null;
  prUrl: string | null;
}

export interface AgentProvider {
  readonly id: string;
  create(input: CreateAgentInput): Promise<{ agentId: string; runId: string }>;
  followUp(agentId: string, prompt: string, busy: boolean): Promise<FollowUpResult>;
  getRun(agentId: string, runId: string): Promise<AgentRunView>;
  latestRunId(agentId: string): Promise<string | null>;
  cancel(agentId: string, runId: string): Promise<void>;
  archive(agentId: string): Promise<void>;
}

export const FUTURE_PROVIDER_IDS = ['openai-agents', 'codex-cli', 'claude-managed'] as const;

export function agentProvider(id: string, env: { CURSOR_API_KEY?: string }, fetchImpl: typeof fetch): AgentProvider {
  if (id === 'cursor') return new CursorProvider(env.CURSOR_API_KEY ?? '', fetchImpl);
  throw new ProviderError('provider_unavailable');
}

const API = 'https://api.cursor.com';
const DEADLINE_MS = 15_000;

export class CursorProvider implements AgentProvider {
  readonly id = 'cursor';

  constructor(private readonly key: string, private readonly fetchImpl: typeof fetch) {}

  async create(input: CreateAgentInput): Promise<{ agentId: string; runId: string }> {
    const repo: { url: string; startingRef?: string } = { url: input.repoUrl };
    if (input.startingRef) repo.startingRef = input.startingRef;
    const body: Record<string, unknown> = {
      prompt: { text: input.prompt },
      repos: [repo],
      autoCreatePR: input.autoCreatePR,
    };
    if (input.model) body.model = { id: input.model };
    if (input.name) body.name = input.name;
    const res = await this.send('/v1/agents', { method: 'POST', body });
    const data = await readBody(res);
    const agentId = nestedString(data, 'agent', 'id');
    const runId = nestedString(data, 'run', 'id');
    if (!agentId || !runId) throw new ProviderError('cursor_unavailable');
    return { agentId, runId };
  }

  async followUp(agentId: string, prompt: string, busy: boolean): Promise<FollowUpResult> {
    if (busy) return this.steer(agentId, prompt);
    const res = await this.send(`/v1/agents/${encodeURIComponent(agentId)}/runs`, {
      method: 'POST',
      body: { prompt: { text: prompt } },
    });
    if (res.status === 409) return this.steer(agentId, prompt);
    const data = await readBody(res);
    const runId = nestedString(data, 'run', 'id');
    if (!runId) throw new ProviderError('cursor_unavailable');
    return { runId, queued: false };
  }

  async getRun(agentId: string, runId: string): Promise<AgentRunView> {
    const res = await this.send(`/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, { method: 'GET' });
    const data = await readBody(res);
    return runView(data, runId);
  }

  async latestRunId(agentId: string): Promise<string | null> {
    const res = await this.send(`/v1/agents/${encodeURIComponent(agentId)}`, { method: 'GET' });
    const data = await readBody(res);
    const id = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).latestRunId : null;
    return typeof id === 'string' && id ? id : null;
  }

  async cancel(agentId: string, runId: string): Promise<void> {
    const res = await this.send(`/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
    if (res.status === 409) return;
    await readBody(res);
  }

  async archive(agentId: string): Promise<void> {
    const res = await this.send(`/v1/agents/${encodeURIComponent(agentId)}/archive`, { method: 'POST' });
    await readBody(res);
  }

  private async steer(agentId: string, prompt: string): Promise<FollowUpResult> {
    const res = await this.send(`/v1/agents/${encodeURIComponent(agentId)}/runs`, {
      method: 'POST',
      body: { prompt: { text: prompt }, delivery: 'steer' },
      steer: true,
    });
    const data = await readBody(res);
    const delivery = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).delivery : null;
    if (delivery === 'queued') return { runId: null, queued: true };
    const runId = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).runId : null;
    return { runId: typeof runId === 'string' && runId ? runId : null, queued: false };
  }

  private async send(path: string, init: { method: string; body?: unknown; steer?: boolean }): Promise<Response> {
    if (!this.key) throw new ProviderError('cursor_unconfigured');
    const res = await this.fetchImpl(`${API}${path}`, {
      method: init.method,
      headers: {
        authorization: `Basic ${btoa(`${this.key}:`)}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    if (res.ok || res.status === 409) return res;
    await res.text().catch(() => '');
    if (res.status === 401) throw new ProviderError('cursor_unauthorized');
    if (res.status === 403 && init.steer) throw new ProviderError('steer_unavailable');
    throw new ProviderError('cursor_unavailable');
  }
}

async function readBody(res: Response): Promise<unknown> {
  if (!res.ok && res.status !== 409) {
    await res.text().catch(() => '');
    throw new ProviderError('cursor_unavailable');
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError('cursor_unavailable');
  }
}

function nestedString(data: unknown, outer: string, inner: string): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const child = (data as Record<string, unknown>)[outer];
  if (!child || typeof child !== 'object' || Array.isArray(child)) return null;
  const value = (child as Record<string, unknown>)[inner];
  return typeof value === 'string' && value ? value : null;
}

function runView(data: unknown, fallbackId: string): AgentRunView {
  const row = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const git = row.git && typeof row.git === 'object' && !Array.isArray(row.git) ? row.git as Record<string, unknown> : null;
  const branches = git && Array.isArray(git.branches) ? git.branches : [];
  let branch: string | null = null;
  let prUrl: string | null = null;
  for (const entry of branches) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (!branch && typeof item.branch === 'string') branch = item.branch;
    if (!prUrl && typeof item.prUrl === 'string') prUrl = item.prUrl;
  }
  return {
    id: typeof row.id === 'string' ? row.id : fallbackId,
    status: typeof row.status === 'string' ? row.status : '',
    result: typeof row.result === 'string' ? row.result : undefined,
    branch,
    prUrl,
  };
}
