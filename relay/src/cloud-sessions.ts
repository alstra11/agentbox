// Cloud sessions are steered here. A local `new` still falls through to the Mac queue.

import type { RelayStore } from './relay-store.ts';
import type { AgentProvider } from './providers.ts';
import { ProviderError } from './providers.ts';
import { parseNeedsYou, withNeedsYou } from './needs-you-block.ts';
import type { AgentRunView } from './providers.ts';
import type { AgentSession, SessionNeed } from './session.ts';
import { CLOUD_POLL_MS } from './session.ts';

export { CLOUD_POLL_MS };

const ACTIVE = new Set(['CREATING', 'RUNNING', 'WAITING_FOR_BACKGROUND_WORK']);
const FAILED = new Set(['ERROR', 'EXPIRED']);

export interface ClientCommand {
  id: string;
  kind: string;
  project?: string | null;
  item?: string | null;
  payload?: Record<string, unknown> | null;
  target?: string;
  provider?: string;
}

export type CloudOk = { ok: true; id: string; sessionId: string; target: string; provider: string };
export type CloudErr = { ok: false; status: number; error: string };

export type Routed =
  | { handled: false }
  | { handled: true; result: CloudOk | CloudErr };

export function projectSlugFromRepo(repo: string): string | null {
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].replace(/\.git$/i, '');
  const slug = last.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  return slug.slice(0, 80);
}

export function sessionSnapshot(session: AgentSession, machine: string) {
  const provider = session.target === 'local' ? machine : session.provider;
  const done = session.status === 'archived' || session.status === 'cancelled';
  const asking = session.status === 'needs-you' || session.status === 'error';
  return {
    v: 3,
    target: session.target,
    provider,
    item: {
      id: session.id,
      title: session.title,
      body: session.prompt,
      status: done ? 'done' : asking ? 'blocked' : 'claimed',
      kind: asking ? 'question' : 'directive',
      result: session.result ?? '',
      updatedAt: Date.parse(session.updatedAt) || 0,
    },
    history: [],
    olderLines: 0,
  };
}

export async function routeClientCommand(
  store: RelayStore,
  cmd: ClientCommand,
  device: string,
  providerFor: (id: string) => AgentProvider,
  now: number,
): Promise<Routed> {
  if (cmd.kind === 'new') {
    const target = (pick(cmd, 'target') ?? 'cloud').toLowerCase();
    if (target === 'local') {
      if (!store.clientStatus(now).macOnline) return handled({ ok: false, status: 409, error: 'mac_offline' });
      return { handled: false };
    }
    if (target !== 'cloud') return handled({ ok: false, status: 400, error: 'bad target' });
    return handled(await startCloud(store, cmd, device, providerFor, now));
  }
  const session = cmd.item ? store.session(cmd.item) : null;
  if (!session || session.target !== 'cloud') return { handled: false };
  return handled(await cloudCommand(store, session, cmd, providerFor, now));
}

export function noteLocalNew(store: RelayStore, cmd: ClientCommand, device: string, now: number) {
  if (store.sessionByCommand(cmd.id)) return;
  const project = typeof cmd.project === 'string' ? cmd.project : '';
  const payload = cmd.payload ?? {};
  const title = text(payload.title) || text(payload.body) || 'Neu';
  const at = new Date(now).toISOString();
  store.saveSession({
    id: freshId(store),
    commandId: cmd.id,
    project,
    provider: 'mac',
    target: 'local',
    externalAgentId: null,
    externalRunId: null,
    runActive: false,
    followUpQueued: false,
    pendingPrompt: null,
    status: 'queued',
    branch: null,
    prUrl: null,
    createdByDevice: device,
    title: title.slice(0, 100),
    prompt: text(payload.body) || title,
    repoUrl: text(payload.repo) || text(payload.repoUrl) || null,
    startingRef: text(payload.startingRef) || null,
    model: text(payload.model) || null,
    result: null,
    createdAt: at,
    updatedAt: at,
  });
}

export async function pollCloudSessions(store: RelayStore, provider: AgentProvider, now: number): Promise<SessionNeed[]> {
  const made: SessionNeed[] = [];
  for (const session of Object.values(store.data.sessions)) {
    if (!polling(session)) continue;
    if (!session.externalAgentId || !session.externalRunId) continue;
    let view: AgentRunView;
    try {
      view = await provider.getRun(session.externalAgentId, session.externalRunId);
    } catch {
      continue;
    }
    applyGit(session, view);
    if (view.status === 'CANCELLED') {
      finishCancelled(session, now);
      continue;
    }
    if (ACTIVE.has(view.status) || !terminal(view.status)) {
      session.runActive = true;
      session.status = 'running';
      session.updatedAt = new Date(now).toISOString();
      continue;
    }
    if (session.pendingPrompt) {
      try {
        const out = await provider.followUp(session.externalAgentId, withNeedsYou(session.pendingPrompt), false);
        session.pendingPrompt = null;
        session.followUpQueued = out.queued;
        if (out.runId) session.externalRunId = out.runId;
        session.runActive = true;
        session.status = 'running';
        session.updatedAt = new Date(now).toISOString();
      } catch {
        // The run is over and the prompt is still here; the next alarm tries again.
      }
      continue;
    }
    if (session.followUpQueued) {
      let latest: string | null = null;
      try {
        latest = await provider.latestRunId(session.externalAgentId);
      } catch {
        continue;
      }
      if (!latest || latest === session.externalRunId) {
        session.runActive = false;
        continue;
      }
      session.externalRunId = latest;
      session.followUpQueued = false;
      try {
        view = await provider.getRun(session.externalAgentId, latest);
      } catch {
        session.runActive = true;
        continue;
      }
      applyGit(session, view);
      if (!terminal(view.status)) {
        session.runActive = true;
        session.status = 'running';
        session.updatedAt = new Date(now).toISOString();
        continue;
      }
      if (view.status === 'CANCELLED') {
        finishCancelled(session, now);
        continue;
      }
    }
    if (store.hasNeed(session.id, view.id)) {
      session.runActive = false;
      session.status = 'needs-you';
      continue;
    }
    const need = buildNeed(session, view, now);
    store.addNeed(need);
    session.runActive = false;
    session.followUpQueued = false;
    session.status = 'needs-you';
    session.updatedAt = need.updatedAt;
    made.push(need);
  }
  return made;
}

async function startCloud(
  store: RelayStore,
  cmd: ClientCommand,
  device: string,
  providerFor: (id: string) => AgentProvider,
  now: number,
): Promise<CloudOk | CloudErr> {
  const prior = store.sessionByCommand(cmd.id);
  if (prior) return ok(prior, cmd.id);
  const payload = cmd.payload ?? {};
  const said = words(payload);
  if (!said) return { ok: false, status: 400, error: 'a new thread needs some words' };
  const repo = text(payload.repo) || text(payload.repoUrl);
  const slugFromRepo = repo ? projectSlugFromRepo(repo) : null;
  if (!repo || !slugFromRepo) return { ok: false, status: 400, error: 'a cloud agent needs a repository' };
  const project = text(cmd.project) || slugFromRepo;
  const providerId = (pick(cmd, 'provider') ?? 'cursor').toLowerCase();
  let provider: AgentProvider;
  try {
    provider = providerFor(providerId);
  } catch (err) {
    return fromError(err);
  }
  const startingRef = text(payload.startingRef) || undefined;
  const model = text(payload.model) || undefined;
  let created: { agentId: string; runId: string };
  try {
    created = await provider.create({
      prompt: withNeedsYou(said.prompt),
      repoUrl: repo,
      startingRef,
      model,
      autoCreatePR: payload.autoCreatePR !== false,
      name: said.title,
    });
  } catch (err) {
    return fromError(err);
  }
  const at = new Date(now).toISOString();
  const session: AgentSession = {
    id: freshId(store),
    commandId: cmd.id,
    project,
    provider: providerId,
    target: 'cloud',
    externalAgentId: created.agentId,
    externalRunId: created.runId,
    runActive: true,
    followUpQueued: false,
    pendingPrompt: null,
    status: 'running',
    branch: null,
    prUrl: null,
    createdByDevice: device,
    title: said.title,
    prompt: said.prompt,
    repoUrl: repo,
    startingRef: startingRef ?? null,
    model: model ?? null,
    result: null,
    createdAt: at,
    updatedAt: at,
  };
  store.saveSession(session);
  if (!store.data.projects[project]) store.putProject(device, project, project, true, now);
  else store.data.projects[project].cloud = true;
  return ok(session, cmd.id);
}

async function cloudCommand(
  store: RelayStore,
  session: AgentSession,
  cmd: ClientCommand,
  providerFor: (id: string) => AgentProvider,
  now: number,
): Promise<CloudOk | CloudErr> {
  if (cmd.kind === 'stop') return cancel(session, providerFor, cmd.id, now);
  if (cmd.kind === 'close') return archive(store, session, providerFor, cmd.id, now);
  if (cmd.kind !== 'reply' && cmd.kind !== 'approve') {
    return { ok: false, status: 400, error: 'not something a cloud session does' };
  }
  if (session.status === 'archived' || session.status === 'cancelled') {
    return { ok: false, status: 400, error: 'that thread is closed' };
  }
  const payload = cmd.payload ?? {};
  const answer = cmd.kind === 'approve' ? approvalText(payload) : text(payload.text);
  if (!answer) return { ok: false, status: 400, error: 'an empty reply' };
  if (isClose(answer)) return archive(store, session, providerFor, cmd.id, now);
  return follow(store, session, answer, providerFor, cmd.id, now);
}

async function follow(
  store: RelayStore,
  session: AgentSession,
  answer: string,
  providerFor: (id: string) => AgentProvider,
  commandId: string,
  now: number,
): Promise<CloudOk | CloudErr> {
  if (!session.externalAgentId) return { ok: false, status: 502, error: 'cursor_unavailable' };
  let provider: AgentProvider;
  try {
    provider = providerFor(session.provider);
  } catch (err) {
    return fromError(err);
  }
  const prompt = withNeedsYou(followUpPrompt(answer, session));
  try {
    const out = await provider.followUp(session.externalAgentId, prompt, session.runActive);
    session.pendingPrompt = null;
    session.followUpQueued = out.queued;
    if (out.runId) session.externalRunId = out.runId;
    session.runActive = true;
    session.status = 'running';
    session.updatedAt = new Date(now).toISOString();
    store.answerNeed(session.id, answer, now);
    return ok(session, commandId);
  } catch (err) {
    // Steering is not on every Cursor account (403). Keep the words and send them when the run ends.
    if (err instanceof ProviderError && err.code === 'steer_unavailable' && session.runActive) {
      session.pendingPrompt = session.pendingPrompt ? `${session.pendingPrompt}\n${answer}` : answer;
      session.updatedAt = new Date(now).toISOString();
      return ok(session, commandId);
    }
    return fromError(err);
  }
}

async function cancel(session: AgentSession, providerFor: (id: string) => AgentProvider, commandId: string, now: number): Promise<CloudOk | CloudErr> {
  if (session.externalAgentId && session.externalRunId) {
    try {
      const provider = providerFor(session.provider);
      await provider.cancel(session.externalAgentId, session.externalRunId);
    } catch (err) {
      return fromError(err);
    }
  }
  finishCancelled(session, now);
  return ok(session, commandId);
}

async function archive(
  store: RelayStore,
  session: AgentSession,
  providerFor: (id: string) => AgentProvider,
  commandId: string,
  now: number,
): Promise<CloudOk | CloudErr> {
  if (session.externalAgentId) {
    try {
      const provider = providerFor(session.provider);
      await provider.archive(session.externalAgentId);
    } catch (err) {
      return fromError(err);
    }
  }
  session.status = 'archived';
  session.runActive = false;
  session.followUpQueued = false;
  session.pendingPrompt = null;
  session.updatedAt = new Date(now).toISOString();
  store.answerNeed(session.id, 'Schließen', now);
  return ok(session, commandId);
}

function buildNeed(session: AgentSession, view: AgentRunView, now: number): SessionNeed {
  const at = new Date(now).toISOString();
  const base = {
    id: `n-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
    sessionId: session.id,
    project: session.project,
    runId: view.id,
    answer: null,
    createdAt: at,
    updatedAt: at,
  };
  if (FAILED.has(view.status)) {
    const line = (view.result ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
    return {
      ...base,
      kind: 'error',
      question: (line || 'Der Lauf ist fehlgeschlagen.').slice(0, 300),
      options: [
        { n: 1, text: 'Nochmal', recommended: true },
        { n: 2, text: 'Weiter', recommended: false },
      ],
      recommended: 'Nochmal',
    };
  }
  const parsed = parseNeedsYou(view.result ?? '');
  if (parsed) {
    return { ...base, kind: parsed.kind, question: parsed.question, options: parsed.options, recommended: parsed.recommended };
  }
  const pr = view.prUrl || session.prUrl;
  const options = [
    { n: 1, text: 'Zusammenführen', recommended: Boolean(pr) },
    { n: 2, text: 'Weiter', recommended: !pr },
    { n: 3, text: 'Schließen', recommended: false },
  ];
  return {
    ...base,
    kind: 'review',
    question: pr ? `Fertig. ${pr}` : 'Fertig.',
    options,
    recommended: options.find((o) => o.recommended)?.text ?? null,
  };
}

function applyGit(session: AgentSession, view: AgentRunView) {
  if (view.branch) session.branch = view.branch;
  if (view.prUrl) session.prUrl = view.prUrl;
  if (typeof view.result === 'string') session.result = view.result.slice(0, 12_000);
}

function finishCancelled(session: AgentSession, now: number) {
  session.status = 'cancelled';
  session.runActive = false;
  session.followUpQueued = false;
  session.pendingPrompt = null;
  session.updatedAt = new Date(now).toISOString();
}

function polling(session: AgentSession): boolean {
  if (session.target !== 'cloud') return false;
  if (session.status === 'archived' || session.status === 'cancelled') return false;
  return session.runActive || session.followUpQueued || Boolean(session.pendingPrompt);
}

function terminal(status: string): boolean {
  return status === 'FINISHED' || status === 'CANCELLED' || FAILED.has(status);
}

function followUpPrompt(answer: string, session: AgentSession): string {
  if (session.prUrl && /zusammenführen|zusammenfuhren|merge/i.test(answer) && !answer.includes(session.prUrl)) {
    return `${answer}\n${session.prUrl}`;
  }
  return answer;
}

function isClose(answer: string): boolean {
  const bare = answer.replace(/^option\s+\d+:\s*/i, '').trim().toLowerCase();
  return bare === 'schließen' || bare === 'schliessen' || bare === 'close' || bare === 'close this task';
}

function approvalText(payload: Record<string, unknown>): string {
  const explicit = text(payload.text);
  if (explicit) return explicit;
  const allow = payload.allow !== false;
  const note = text(payload.note);
  const word = allow ? 'Erlauben' : 'Ablehnen';
  return note ? `${word}: ${note}` : word;
}

function words(payload: Record<string, unknown>): { title: string; prompt: string } | null {
  const title = text(payload.title);
  const body = text(payload.body);
  const prompt = body || title;
  if (!prompt) return null;
  const named = title || prompt.split('\n')[0] || prompt;
  return { title: named.slice(0, 100), prompt };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pick(cmd: ClientCommand, key: 'target' | 'provider'): string | undefined {
  const inner = cmd.payload?.[key];
  if (typeof inner === 'string' && inner.trim()) return inner.trim();
  const top = cmd[key];
  if (typeof top === 'string' && top.trim()) return top.trim();
  return undefined;
}

function freshId(store: RelayStore): string {
  for (let i = 0; i < 5; i += 1) {
    const id = `c-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
    if (!store.session(id)) return id;
  }
  return `c-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function ok(session: AgentSession, id: string): CloudOk {
  return { ok: true, id, sessionId: session.id, target: session.target, provider: session.provider };
}

function handled(result: CloudOk | CloudErr): Routed {
  return { handled: true, result };
}

function fromError(err: unknown): CloudErr {
  if (err instanceof ProviderError) {
    return { ok: false, status: statusFor(err.code), error: err.code };
  }
  return { ok: false, status: 502, error: 'cursor_unavailable' };
}

function statusFor(code: string): number {
  if (code === 'cursor_unconfigured') return 503;
  if (code === 'provider_unavailable') return 400;
  if (code === 'cursor_unauthorized' || code === 'cursor_unavailable') return 502;
  return 502;
}
