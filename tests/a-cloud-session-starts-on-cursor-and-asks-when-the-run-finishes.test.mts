// A CLOUD SESSION STARTS ON CURSOR AND ASKS WHEN THE RUN FINISHES.
//
// The relay only queued phone commands for the Mac, so nothing ran while the
// Mac was off and a finished cloud run never asked. Measured with a fake
// Cursor API and an in-memory RelayStore: no socket to api.cursor.com.
import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { RelayStore } from '../relay/src/relay-store.ts';
import { handleRelay, ntfyNotify } from '../relay/src/http.ts';
import { macOnlineAt } from '../shared/relay-needs-you.mts';
import { parseNeedsYou, withNeedsYou } from '../relay/src/needs-you-block.ts';
import { projectSlugFromRepo, pollCloudSessions, CLOUD_POLL_MS } from '../relay/src/cloud-sessions.ts';
import { CursorProvider, ProviderError, agentProvider, FUTURE_PROVIDER_IDS } from '../relay/src/providers.ts';
import type { AgentProvider, AgentRunView } from '../relay/src/providers.ts';
import { relayHarnesses } from '../shared/relay-harnesses.mts';

const KEY = 'super-secret-cursor-key';
const env = {
  MAC_TOKEN: 'mac-secret',
  IPHONE_TOKEN: 'iphone-secret',
  WATCH_TOKEN: 'watch-secret',
  NTFY_TOPIC: 'home',
  CURSOR_API_KEY: KEY,
};
const device = 'abcabcabcabc';
const NOW = 1_710_000_000_000;

function client(path: string, body?: unknown, token = env.IPHONE_TOKEN) {
  return new Request(`https://agents.example${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-agentbox-device': device,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

class FakeCursor implements AgentProvider {
  readonly id = 'cursor';
  creates: { prompt: string; repoUrl: string; startingRef?: string; model?: string; autoCreatePR: boolean; name?: string }[] = [];
  followUps: { agentId: string; prompt: string; busy: boolean }[] = [];
  cancelled: string[] = [];
  archived: string[] = [];
  runs = new Map<string, AgentRunView>();
  latest = new Map<string, string>();
  failSteer = false;
  nextRun = 'run-2';

  async create(input: FakeCursor['creates'][number]) {
    this.creates.push(input);
    return { agentId: 'bc-1', runId: 'run-1' };
  }

  async followUp(agentId: string, prompt: string, busy: boolean) {
    this.followUps.push({ agentId, prompt, busy });
    if (busy && this.failSteer) throw new ProviderError('steer_unavailable');
    if (busy) return { runId: 'run-1', queued: false };
    return { runId: this.nextRun, queued: false };
  }

  async getRun(_agentId: string, runId: string): Promise<AgentRunView> {
    return this.runs.get(runId) ?? { id: runId, status: 'RUNNING', branch: null, prUrl: null };
  }

  async latestRunId(agentId: string) {
    return this.latest.get(agentId) ?? null;
  }

  async cancel(_agentId: string, runId: string) {
    this.cancelled.push(runId);
  }

  async archive(agentId: string) {
    this.archived.push(agentId);
  }
}

function harness(store = new RelayStore(), fake = new FakeCursor(), fetchImpl?: typeof fetch) {
  const seen: string[] = [];
  const call = (req: Request) => handleRelay(req, store, env, device, fetchImpl ?? (async () => new Response('{}')), {
    now: NOW,
    providerFor: (id) => {
      seen.push(id);
      if (id !== 'cursor') return agentProvider(id, env, fetchImpl ?? fetch);
      return fake;
    },
  });
  return { store, fake, seen, call };
}

describe('cloud is the default and the Mac only takes local work', () => {
  it('starts a cursor agent for a new command that names no target, and the Mac queue stays empty', async () => {
    const { store, fake, seen, call } = harness();
    const res = await call(client('/client/commands', {
      id: 'cmd-1',
      kind: 'new',
      payload: { body: 'Add a health check', repo: 'https://github.com/acme/Agentbox.git' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; id: string; sessionId: string; target: string; provider: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe('cmd-1');
    expect(body.sessionId).toMatch(/^c-[0-9a-f]{10}$/);
    expect(body.target).toBe('cloud');
    expect(body.provider).toBe('cursor');
    expect(seen).toEqual(['cursor']);
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0].repoUrl).toBe('https://github.com/acme/Agentbox.git');
    expect(fake.creates[0].autoCreatePR).toBe(true);
    expect(fake.creates[0].prompt).toContain('Add a health check');
    expect(fake.creates[0].prompt).toContain('NEEDS_YOU{"question"');
    expect(store.waitingCommands(device)).toEqual([]);
    expect(store.projectsList().some((p) => p.slug === 'agentbox' && p.cloud)).toBe(true);

    const again = await call(client('/client/commands', {
      id: 'cmd-1',
      kind: 'new',
      payload: { body: 'Add a health check', repo: 'https://github.com/acme/Agentbox.git' },
    }));
    expect((await again.json() as { sessionId: string }).sessionId).toBe(body.sessionId);
    expect(fake.creates).toHaveLength(1);
  });

  it('accepts target and provider on the command itself and passes model and starting ref', async () => {
    const { fake, call } = harness();
    const res = await call(client('/client/commands', {
      id: 'cmd-top',
      kind: 'new',
      target: 'cloud',
      provider: 'cursor',
      payload: {
        title: 'Health',
        body: 'Add a health check',
        repo: 'https://github.com/acme/agentbox',
        startingRef: 'release',
        model: 'composer-2',
      },
    }));
    expect(res.status).toBe(200);
    expect(fake.creates[0].startingRef).toBe('release');
    expect(fake.creates[0].model).toBe('composer-2');
    expect(fake.creates[0].name).toBe('Health');
    expect(fake.creates[0].autoCreatePR).toBe(true);
  });

  it('refuses a local new at 90s and accepts one 1ms inside that window', async () => {
    const offline = harness();
    offline.store.putProject(device, 'alpha', 'Alpha');
    offline.store.setStatus(device, { at: NOW - 90_000, computerName: 'MacBook' });
    const refused = await offline.call(client('/client/commands', {
      id: 'local-off',
      kind: 'new',
      payload: { title: 'Fix', body: 'Fix the tray', target: 'local', repo: 'https://github.com/acme/agentbox' },
      project: 'alpha',
    }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'mac_offline' });
    expect(offline.store.waitingCommands(device)).toEqual([]);
    expect(offline.fake.creates).toEqual([]);

    const online = harness();
    online.store.putProject(device, 'alpha', 'Alpha');
    online.store.setStatus(device, { at: NOW - 89_999, computerName: 'MacBook' });
    const ok = await online.call(client('/client/commands', {
      id: 'local-on',
      kind: 'new',
      project: 'alpha',
      payload: { title: 'Fix', body: 'Fix the tray', target: 'local' },
    }));
    expect(ok.status).toBe(200);
    expect(online.fake.creates).toEqual([]);
    const queued = online.store.waitingCommands(device);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload.target).toBe('local');
    expect(queued[0].kind).toBe('new');
  });

  it('does not treat a Mac that was seen 120s ago as online', () => {
    expect(macOnlineAt(null, NOW)).toBe(false);
    expect(macOnlineAt(NOW, NOW)).toBe(true);
    expect(macOnlineAt(NOW - 89_999, NOW)).toBe(true);
    expect(macOnlineAt(NOW - 90_000, NOW)).toBe(false);
    expect(macOnlineAt(NOW - 120_000, NOW)).toBe(false);
  });

  it('queues a reply to a Mac thread and answers a cloud thread itself', async () => {
    const { store, fake, call } = harness();
    store.putProject(device, 'alpha', 'Alpha');
    store.putThreads(device, 'alpha', [{
      item: 'w-abc1234567',
      snapshot: { item: { id: 'w-abc1234567', title: 'Ship?', status: 'blocked', kind: 'question', updatedAt: 1 } },
    }]);
    const local = await call(client('/client/commands', {
      kind: 'reply', project: 'alpha', item: 'w-abc1234567', payload: { text: 'Ship it' },
    }));
    expect(local.status).toBe(200);
    expect(store.waitingCommands(device)).toHaveLength(1);
    expect(fake.followUps).toEqual([]);

    const started = await call(client('/client/commands', {
      id: 'cmd-cloud',
      kind: 'new',
      payload: { body: 'Add a health check', repo: 'https://github.com/acme/agentbox' },
    }));
    const { sessionId } = await started.json() as { sessionId: string };
    const reply = await call(client('/client/commands', {
      kind: 'reply', project: 'agentbox', item: sessionId, payload: { text: 'Also cover timeouts' },
    }));
    expect(reply.status).toBe(200);
    expect(fake.followUps).toEqual([{ agentId: 'bc-1', prompt: expect.stringContaining('Also cover timeouts'), busy: true }]);
    expect(store.waitingCommands(device).map((c) => c.item)).toEqual(['w-abc1234567']);
  });

  it('will not let the Mac claim a command aimed at a cloud session', () => {
    const store = new RelayStore();
    store.data.commands.push({
      id: 'cloud-cmd',
      device,
      source: 'iphone',
      project: 'agentbox',
      item: 'c-123',
      kind: 'reply',
      payload: { text: 'hi', target: 'cloud' },
      createdAt: '2026-01-01T00:00:00.000Z',
      claimedAt: null,
      takenAt: null,
      outcome: null,
    });
    store.data.commands.push({
      id: 'local-cmd',
      device,
      source: 'watch',
      project: 'alpha',
      item: 'w-1',
      kind: 'reply',
      payload: { text: 'hi' },
      createdAt: '2026-01-01T00:00:01.000Z',
      claimedAt: null,
      takenAt: null,
      outcome: null,
    });
    expect(store.waitingCommands(device).map((c) => c.id)).toEqual(['local-cmd']);
    expect(store.claimCommand('cloud-cmd')).toBe('gone');
    expect(store.data.commands.find((c) => c.id === 'cloud-cmd')?.claimedAt).toBeNull();
    expect(store.claimCommand('local-cmd')).toBe('claimed');
  });

  it('refuses an empty prompt, a repo with a secret in it, and providers that are not cursor', async () => {
    const { fake, call } = harness();
    const empty = await call(client('/client/commands', {
      kind: 'new', payload: { body: '   ', repo: 'https://github.com/acme/agentbox' },
    }));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'a new thread needs some words' });

    const secret = await call(client('/client/commands', {
      kind: 'new', payload: { body: 'Add a check', repo: 'https://user:token@github.com/acme/agentbox' },
    }));
    expect(secret.status).toBe(400);
    expect(fake.creates).toEqual([]);

    const javascript = await call(client('/client/commands', {
      kind: 'new', payload: { body: 'Add a check', repo: 'javascript:alert(1)' },
    }));
    expect(javascript.status).toBe(400);

    for (const provider of [...FUTURE_PROVIDER_IDS, 'grok']) {
      const res = await call(client('/client/commands', {
        kind: 'new', payload: { body: 'Add a check', repo: 'https://github.com/acme/agentbox', provider },
      }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'provider_unavailable' });
    }
    expect(fake.creates).toEqual([]);
  });
});

describe('the cursor request matches the v1 agents API and the key stays out', () => {
  it('posts the agent, steers when the run is busy, and never echoes the key', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const path = new URL(url).pathname;
      if (path === '/v1/agents' && init.method === 'POST') {
        return new Response(JSON.stringify({
          agent: { id: 'bc-1', latestRunId: 'run-1' },
          run: { id: 'run-1', status: 'CREATING' },
        }), { status: 200 });
      }
      if (path === '/v1/agents/bc-1/runs' && init.method === 'POST') {
        const sent = JSON.parse(String(init.body));
        if (sent.delivery !== 'steer') return new Response(JSON.stringify({ error: `busy ${KEY}` }), { status: 409 });
        return new Response(JSON.stringify({ delivery: 'steered', runId: 'run-1' }), { status: 202 });
      }
      if (path === '/v1/agents/bc-1/runs/run-1' && (!init.method || init.method === 'GET')) {
        return new Response(JSON.stringify({
          id: 'run-1',
          status: 'FINISHED',
          result: 'Done.',
          git: { branches: [{ repoUrl: 'github.com/acme/agentbox', branch: 'cursor/health', prUrl: 'https://github.com/acme/agentbox/pull/4' }] },
        }), { status: 200 });
      }
      if (path.endsWith('/cancel')) return new Response(JSON.stringify({ id: 'run-1' }), { status: 200 });
      if (path.endsWith('/archive')) return new Response('{}', { status: 200 });
      if (path === '/v1/agents/bc-1') return new Response(JSON.stringify({ latestRunId: 'run-9' }), { status: 200 });
      return new Response(JSON.stringify({ error: KEY }), { status: 500 });
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { logs.push(args.map(String).join(' ')); });
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => { logs.push(args.map(String).join(' ')); });
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.map(String).join(' ')); });
    try {
      const provider = new CursorProvider(KEY, fetchImpl);
      const created = await provider.create({
        prompt: withNeedsYou('Add a health check'),
        repoUrl: 'https://github.com/acme/agentbox',
        startingRef: 'main',
        model: 'composer-2',
        autoCreatePR: true,
        name: 'Health',
      });
      expect(created).toEqual({ agentId: 'bc-1', runId: 'run-1' });
      const create = seen[0];
      expect(create.url).toBe('https://api.cursor.com/v1/agents');
      expect(create.url.includes(KEY)).toBe(false);
      const headers = new Headers(create.init.headers);
      expect(headers.get('authorization')).toBe(`Basic ${btoa(`${KEY}:`)}`);
      expect(create.init.signal).toBeInstanceOf(AbortSignal);
      const sent = JSON.parse(String(create.init.body));
      expect(sent.prompt.text).toContain('Add a health check');
      expect(sent.prompt.text).toContain('NEEDS_YOU{"question"');
      expect(sent.repos).toEqual([{ url: 'https://github.com/acme/agentbox', startingRef: 'main' }]);
      expect(sent.autoCreatePR).toBe(true);
      expect(sent.model).toEqual({ id: 'composer-2' });
      expect(sent.name).toBe('Health');
      expect(JSON.stringify(sent).includes(KEY)).toBe(false);

      const steered = await provider.followUp('bc-1', 'Also cover timeouts', true);
      expect(steered).toEqual({ runId: 'run-1', queued: false });
      expect(seen).toHaveLength(2);
      const steerBody = JSON.parse(String(seen.at(-1)!.init.body));
      expect(steerBody).toEqual({ prompt: { text: 'Also cover timeouts' }, delivery: 'steer' });
      expect(Object.keys(steerBody).sort()).toEqual(['delivery', 'prompt']);

      const idle = new CursorProvider(KEY, vi.fn(async (_url: string, init: RequestInit) => {
        const sent = JSON.parse(String(init.body));
        if (sent.delivery) throw new Error('idle follow-up must not steer');
        return new Response(JSON.stringify({ run: { id: 'run-2', status: 'CREATING' } }), { status: 200 });
      }));
      expect(await idle.followUp('bc-1', 'next', false)).toEqual({ runId: 'run-2', queued: false });

      const run = await provider.getRun('bc-1', 'run-1');
      expect(run.status).toBe('FINISHED');
      expect(run.branch).toBe('cursor/health');
      expect(run.prUrl).toBe('https://github.com/acme/agentbox/pull/4');
      expect(await provider.latestRunId('bc-1')).toBe('run-9');
      await provider.cancel('bc-1', 'run-1');
      await provider.archive('bc-1');

      const broken = new CursorProvider(KEY, async () => new Response(JSON.stringify({ error: KEY }), { status: 500 }));
      await expect(broken.create({
        prompt: 'x', repoUrl: 'https://github.com/acme/agentbox', autoCreatePR: true,
      })).rejects.toMatchObject({ code: 'cursor_unavailable' });
      const missing = new CursorProvider('', fetchImpl);
      await expect(missing.create({
        prompt: 'x', repoUrl: 'https://github.com/acme/agentbox', autoCreatePR: true,
      })).rejects.toMatchObject({ code: 'cursor_unconfigured' });
    } finally {
      spy.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
    expect(logs.join('\n').includes(KEY)).toBe(false);
    expect(seen.every((c) => !c.url.includes(KEY) && !String(c.init.body ?? '').includes(KEY))).toBe(true);
  });

  it('omits model and startingRef when the client did not send them', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      agent: { id: 'bc-1' }, run: { id: 'run-1' },
    }), { status: 200 }));
    const provider = new CursorProvider(KEY, fetchImpl);
    await provider.create({ prompt: 'Add a check', repoUrl: 'https://github.com/acme/agentbox', autoCreatePR: false });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(sent.repos).toEqual([{ url: 'https://github.com/acme/agentbox' }]);
    expect(sent.autoCreatePR).toBe(false);
    expect(sent.model).toBeUndefined();
    expect(sent.name).toBeUndefined();
  });

  it('a missing key refuses the command before any request', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const store = new RelayStore();
    const res = await handleRelay(client('/client/commands', {
      kind: 'new', payload: { body: 'Add a check', repo: 'https://github.com/acme/agentbox' },
    }), store, { ...env, CURSOR_API_KEY: '' }, device, fetchImpl, { now: NOW });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: 'cursor_unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(text.includes(KEY)).toBe(false);
  });
});

describe('a finished run asks, and a run that is not finished does not', () => {
  async function started() {
    const box = harness();
    const res = await box.call(client('/client/commands', {
      id: 'cmd-run',
      kind: 'new',
      payload: { body: 'Add a health check', repo: 'https://github.com/acme/agentbox' },
    }));
    const { sessionId } = await res.json() as { sessionId: string };
    return { ...box, sessionId };
  }

  it('parses the last NEEDS_YOU block and ignores a block that is not a decision', () => {
    const parsed = parseNeedsYou('Working.\nNEEDS_YOU{"question":"Ignore?","options":[{"text":"No"}]}\nNEEDS_YOU{"question":"Ship it?","options":[{"text":"Ship","recommended":true},{"text":"Wait"}],"recommended":"Wait"}');
    expect(parsed?.question).toBe('Ship it?');
    expect(parsed?.kind).toBe('question');
    expect(parsed?.options.map((o) => [o.text, o.recommended])).toEqual([['Ship', false], ['Wait', true]]);

    expect(parseNeedsYou('I wrote NEEDS_YOU in the log')).toBeNull();
    expect(parseNeedsYou('NEEDS_YOU{question:}')).toBeNull();
    expect(parseNeedsYou('NEEDS_YOU{"question":"  ","options":[{"text":"A"}]}')).toBeNull();
    expect(parseNeedsYou('NEEDS_YOU{"question":"Ship?","options":[]}')).toBeNull();
    expect(parseNeedsYou('NEEDS_YOU{"question":"Allow bash?","kind":"approval","options":[{"text":"Allow","recommended":true},{"text":"Deny"}]}')?.kind).toBe('approval');
  });

  it('turns a finish with a pull request into one review and notifies once', async () => {
    const box = await started();
    box.fake.runs.set('run-1', {
      id: 'run-1', status: 'FINISHED', result: 'Added the check.', branch: 'cursor/health', prUrl: 'https://github.com/acme/agentbox/pull/4',
    });
    const first = await pollCloudSessions(box.store, box.fake, NOW);
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe('review');
    expect(first[0].question).toContain('https://github.com/acme/agentbox/pull/4');
    expect(first[0].options.map((o) => o.text)).toEqual(['Zusammenführen', 'Weiter', 'Schließen']);
    expect(first[0].options[0].recommended).toBe(true);
    expect(first[0].options[2].recommended).toBe(false);
    const session = box.store.session(box.sessionId);
    expect(session?.branch).toBe('cursor/health');
    expect(session?.prUrl).toBe('https://github.com/acme/agentbox/pull/4');
    expect(session?.runActive).toBe(false);
    expect(box.store.nextCloudAlarm(NOW)).toBeNull();

    const listed = await box.call(client('/client/needs-you'));
    const items = (await listed.json() as { items: { id: string; target?: string; provider?: string; kind?: string }[] }).items;
    expect(items.map((i) => i.id)).toEqual([box.sessionId]);
    expect(items[0].target).toBe('cloud');
    expect(items[0].provider).toBe('cursor');

    const snap = await box.call(client(`/client/threads/agentbox/${box.sessionId}`));
    const snapshot = (await snap.json() as { snapshot: { target?: string; provider?: string } }).snapshot;
    expect(snapshot.target).toBe('cloud');
    expect(snapshot.provider).toBe('cursor');

    const fetchMock = vi.fn(async () => new Response('ok'));
    const fresh = box.store.freshNeedsYou(NOW);
    box.store.markNotified(fresh);
    await ntfyNotify(fresh, 'home', 'https://ntfy.sh', fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers as HeadersInit);
    expect(headers.get('Click')).toBe(`agentbox://thread/${box.sessionId}?project=agentbox`);

    expect(await pollCloudSessions(box.store, box.fake, NOW)).toEqual([]);
    expect(box.store.freshNeedsYou(NOW)).toEqual([]);
    expect(box.store.needsYou(NOW)).toHaveLength(1);
  });

  it('a finish without a pull request recommends continuing, and a question block wins over review', async () => {
    const noPr = await started();
    noPr.fake.runs.set('run-1', { id: 'run-1', status: 'FINISHED', result: 'Done.', branch: null, prUrl: null });
    const review = await pollCloudSessions(noPr.store, noPr.fake, NOW);
    expect(review[0].options.find((o) => o.text === 'Weiter')?.recommended).toBe(true);
    expect(review[0].options.find((o) => o.text === 'Zusammenführen')?.recommended).toBe(false);
    expect(review[0].question.includes('http')).toBe(false);

    const asked = await started();
    asked.fake.runs.set('run-1', {
      id: 'run-1',
      status: 'FINISHED',
      result: 'I can ship.\nNEEDS_YOU{"question":"Ship it?","options":[{"text":"Ship","recommended":true},{"text":"Wait"}]}',
      branch: 'cursor/health',
      prUrl: 'https://github.com/acme/agentbox/pull/4',
    });
    const question = await pollCloudSessions(asked.store, asked.fake, NOW);
    expect(question[0].kind).toBe('question');
    expect(question[0].question).toBe('Ship it?');
    expect(question[0].options.map((o) => o.text)).toEqual(['Ship', 'Wait']);
    expect(question[0].recommended).toBe('Ship');
  });

  it('an error stays an error even when the text contains NEEDS_YOU, and a waiting run does not ask', async () => {
    const errored = await started();
    errored.fake.runs.set('run-1', {
      id: 'run-1',
      status: 'ERROR',
      result: 'boom\nNEEDS_YOU{"question":"Ship?","options":[{"text":"Ship","recommended":true}]}',
      branch: null,
      prUrl: null,
    });
    const errorItem = await pollCloudSessions(errored.store, errored.fake, NOW);
    expect(errorItem[0].kind).toBe('error');
    expect(errorItem[0].options.map((o) => o.text)).toEqual(['Nochmal', 'Weiter']);
    expect(errorItem[0].options[0].recommended).toBe(true);
    expect(errorItem[0].question).toContain('boom');

    const waiting = await started();
    for (const status of ['CREATING', 'RUNNING', 'WAITING_FOR_BACKGROUND_WORK', 'FINISHING']) {
      waiting.fake.runs.set('run-1', { id: 'run-1', status, result: 'NEEDS_YOU{"question":"Ship?","options":[{"text":"Ship"}]}', branch: null, prUrl: null });
      expect(await pollCloudSessions(waiting.store, waiting.fake, NOW)).toEqual([]);
      expect(waiting.store.needsYou(NOW)).toEqual([]);
    }
    expect(waiting.store.nextCloudAlarm(NOW)).toBe(NOW + CLOUD_POLL_MS);
    expect(CLOUD_POLL_MS).toBe(30_000);

    const cancelled = await started();
    cancelled.fake.runs.set('run-1', { id: 'run-1', status: 'CANCELLED', branch: null, prUrl: null });
    expect(await pollCloudSessions(cancelled.store, cancelled.fake, NOW)).toEqual([]);
    expect(cancelled.store.session(cancelled.sessionId)?.status).toBe('cancelled');
    expect(cancelled.store.nextCloudAlarm(NOW)).toBeNull();

    const expired = await started();
    expired.fake.runs.set('run-1', { id: 'run-1', status: 'EXPIRED', result: '', branch: null, prUrl: null });
    const expiredItem = await pollCloudSessions(expired.store, expired.fake, NOW);
    expect(expiredItem[0].kind).toBe('error');
    expect(expiredItem[0].question.length).toBeGreaterThan(0);
  });
});

describe('commands on a cloud session', () => {
  async function running() {
    const box = harness();
    const res = await box.call(client('/client/commands', {
      id: 'cmd-run',
      kind: 'new',
      payload: { body: 'Add a health check', repo: 'https://github.com/acme/agentbox' },
    }));
    const { sessionId } = await res.json() as { sessionId: string };
    return { ...box, sessionId };
  }

  it('stop cancels, close archives, and a cloud session rejects a snooze', async () => {
    const box = await running();
    const stop = await box.call(client('/client/commands', {
      kind: 'stop', project: 'agentbox', item: box.sessionId, payload: {},
    }));
    expect(stop.status).toBe(200);
    expect(box.fake.cancelled).toEqual(['run-1']);
    expect(box.store.session(box.sessionId)?.status).toBe('cancelled');
    expect(box.store.waitingCommands(device)).toEqual([]);

    const other = await running();
    const close = await other.call(client('/client/commands', {
      kind: 'close', project: 'agentbox', item: other.sessionId, payload: {},
    }));
    expect(close.status).toBe(200);
    expect(other.fake.archived).toEqual(['bc-1']);
    expect(other.store.session(other.sessionId)?.status).toBe('archived');

    const snooze = await other.call(client('/client/commands', {
      kind: 'snooze', project: 'agentbox', item: other.sessionId, payload: { until: 0 },
    }));
    expect(snooze.status).toBe(400);
    expect(other.fake.followUps).toEqual([]);
  });

  it('follows up with the chosen option, archives Schließen, and holds a steer the account cannot take', async () => {
    const box = await running();
    box.fake.runs.set('run-1', {
      id: 'run-1', status: 'FINISHED', result: 'Done.', branch: 'cursor/health', prUrl: 'https://github.com/acme/agentbox/pull/4',
    });
    await pollCloudSessions(box.store, box.fake, NOW);
    const merge = await box.call(client('/client/commands', {
      kind: 'reply', project: 'agentbox', item: box.sessionId, payload: { text: 'Option 1: Zusammenführen' },
    }));
    expect(merge.status).toBe(200);
    expect(box.fake.followUps.at(-1)?.busy).toBe(false);
    expect(box.fake.followUps.at(-1)?.prompt).toContain('Zusammenführen');
    expect(box.fake.followUps.at(-1)?.prompt).toContain('https://github.com/acme/agentbox/pull/4');
    expect(box.store.needsYou(NOW)).toEqual([]);

    const closing = await running();
    closing.fake.runs.set('run-1', { id: 'run-1', status: 'FINISHED', result: 'Done.', branch: null, prUrl: null });
    await pollCloudSessions(closing.store, closing.fake, NOW);
    const shut = await closing.call(client('/client/commands', {
      kind: 'reply', project: 'agentbox', item: closing.sessionId, payload: { text: 'Option 3: Schließen' },
    }));
    expect(shut.status).toBe(200);
    expect(closing.fake.archived).toEqual(['bc-1']);
    expect(closing.fake.followUps).toEqual([]);

    const busy = await running();
    busy.fake.failSteer = true;
    const held = await busy.call(client('/client/commands', {
      kind: 'reply', project: 'agentbox', item: busy.sessionId, payload: { text: 'Check the edge' },
    }));
    expect(held.status).toBe(200);
    expect(busy.store.session(busy.sessionId)?.pendingPrompt).toContain('Check the edge');
    busy.fake.failSteer = false;
    busy.fake.runs.set('run-1', { id: 'run-1', status: 'FINISHED', result: 'Done.', branch: null, prUrl: null });
    expect(await pollCloudSessions(busy.store, busy.fake, NOW)).toEqual([]);
    expect(busy.fake.followUps.at(-1)?.busy).toBe(false);
    expect(busy.fake.followUps.at(-1)?.prompt).toContain('Check the edge');
    expect(busy.store.session(busy.sessionId)?.pendingPrompt ?? null).toBeNull();
    expect(busy.store.needsYou(NOW)).toEqual([]);
  });

  it('sends an approval as a follow-up once the run is idle', async () => {
    const box = await running();
    box.fake.runs.set('run-1', { id: 'run-1', status: 'FINISHED', result: 'Need a yes.', branch: null, prUrl: null });
    await pollCloudSessions(box.store, box.fake, NOW);
    const res = await box.call(client('/client/commands', {
      kind: 'approve',
      project: 'agentbox',
      item: box.sessionId,
      payload: { approval: 'card-1', allow: false, card: 'abcdefgh', note: 'not this' },
    }));
    expect(res.status).toBe(200);
    expect(box.fake.followUps.at(-1)?.prompt).toContain('Ablehnen');
    expect(box.fake.followUps.at(-1)?.prompt).toContain('not this');
    expect(box.store.waitingCommands(device)).toEqual([]);
  });

  it('adopts the next run when a steer was only queued', async () => {
    const box = await running();
    box.fake.followUp = async (agentId: string, prompt: string, busy: boolean) => {
      box.fake.followUps.push({ agentId, prompt, busy });
      return { runId: null, queued: true };
    };
    await box.call(client('/client/commands', {
      kind: 'reply', project: 'agentbox', item: box.sessionId, payload: { text: 'Also the edge' },
    }));
    expect(box.store.session(box.sessionId)?.followUpQueued).toBe(true);
    box.fake.runs.set('run-1', { id: 'run-1', status: 'FINISHED', result: 'Done.', branch: null, prUrl: null });
    box.fake.latest.set('bc-1', 'run-1');
    expect(await pollCloudSessions(box.store, box.fake, NOW)).toEqual([]);
    box.fake.latest.set('bc-1', 'run-2');
    box.fake.runs.set('run-2', { id: 'run-2', status: 'RUNNING', branch: null, prUrl: null });
    expect(await pollCloudSessions(box.store, box.fake, NOW)).toEqual([]);
    expect(box.store.session(box.sessionId)?.externalRunId).toBe('run-2');
    expect(box.store.needsYou(NOW)).toEqual([]);
    expect(box.store.nextCloudAlarm(NOW)).toBe(NOW + 30_000);
  });
});

describe('targets and the thread badge fields', () => {
  it('lists cloud as the default and local harnesses only while the Mac is online', async () => {
    const { store, call } = harness();
    store.setStatus(device, {
      at: NOW - 90_000,
      computerName: 'MacBook',
      harnesses: [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }],
    });
    const off = await call(client('/client/targets'));
    expect(off.status).toBe(200);
    const offline = await off.json() as {
      macOnline: boolean;
      defaultTarget: string;
      computerName: string;
      harnesses: { id: string; available: boolean }[];
      targets: { target: string; provider: string; label: string; available: boolean }[];
    };
    expect(offline.macOnline).toBe(false);
    expect(offline.defaultTarget).toBe('cloud');
    expect(offline.computerName).toBe('MacBook');
    expect(offline.harnesses.every((h) => h.available === false)).toBe(true);
    expect(offline.targets).toEqual([
      { target: 'cloud', provider: 'cursor', label: 'Cloud · Cursor', available: true },
      { target: 'local', provider: 'mac', label: 'Lokal · MacBook', available: false },
    ]);

    store.setStatus(device, {
      at: NOW - 1_000,
      computerName: 'MacBook',
      harnesses: [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }],
    });
    const status = await (await call(client('/client/status'))).json() as { macOnline: boolean; harnesses: { available: boolean }[] };
    expect(status.macOnline).toBe(true);
    expect(status.harnesses.every((h) => h.available)).toBe(true);
    const on = await (await call(client('/client/targets'))).json() as { targets: { target: string; available: boolean }[] };
    expect(on.targets.find((t) => t.target === 'local')?.available).toBe(true);

    store.putProject(device, 'alpha', 'Alpha');
    store.putThreads(device, 'alpha', [{
      item: 'w-1',
      snapshot: { v: 3, item: { id: 'w-1', title: 'T', status: 'blocked', kind: 'question', updatedAt: 5 }, history: [], olderLines: 0 },
    }]);
    const snap = await (await call(client('/client/threads/alpha/w-1'))).json() as { snapshot: { target?: string; provider?: string } };
    expect(snap.snapshot.target).toBe('local');
    expect(snap.snapshot.provider).toBe('MacBook');
    const items = (await (await call(client('/client/needs-you'))).json() as { items: { target?: string; provider?: string }[] }).items;
    expect(items[0].target).toBe('local');
    expect(items[0].provider).toBe('MacBook');
  });

  it('names the Mac when no computer name has arrived, and the harness list is the admitted engines', () => {
    expect(projectSlugFromRepo('https://github.com/acme/Agentbox.git')).toBe('agentbox');
    expect(projectSlugFromRepo('https://github.com/acme/my_app')).toBe('my-app');
    expect(projectSlugFromRepo('https://github.com/acme/')).toBeNull();
    expect(projectSlugFromRepo('https://user:token@github.com/acme/repo')).toBeNull();
    expect(projectSlugFromRepo('not a url')).toBeNull();
    const names = relayHarnesses().map((h) => h.id);
    expect(names).toContain('claude');
    expect(names).toContain('codex');
    expect(names).not.toContain('opencode');
  });

  it('a broken percent in a thread path is not found', async () => {
    const { call } = harness();
    const res = await call(client('/client/threads/%E0%A4%A/w-1'));
    expect(res.status).toBe(404);
  });

  it('the durable object alarm polls active runs and reschedules', () => {
    const src = fs.readFileSync(new URL('../relay/src/relay-room.ts', import.meta.url), 'utf8');
    expect(src).toContain('pollCloudSessions');
    expect(src).toContain('setAlarm');
    expect(src).toContain('notifyFresh');
    expect(src.includes('CURSOR_API_KEY')).toBe(false);
  });
});
