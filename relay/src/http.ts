// HTTP handlers for the agents relay worker.

import { RelayStore } from './relay-store.ts';
import type { RelayCommandIn, RelayMacStatus } from '../../shared/relay-types.mts';

export type RelayEnv = {
  MAC_TOKEN: string;
  CLIENT_TOKEN: string;
  NTFY_URL?: string;
  NTFY_TOPIC?: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function unauthorized() {
  return json({ error: 'unauthorized' }, 401);
}

function bad(msg: string) {
  return json({ error: msg }, 400);
}

function token(req: Request, role: 'mac' | 'client', env: RelayEnv) {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const got = m?.[1]?.trim();
  const want = role === 'mac' ? env.MAC_TOKEN : env.CLIENT_TOKEN;
  return got && want && got === want;
}

export async function ntfyNotify(
  items: { id: string; title: string; question: string; project: string }[],
  topic: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
) {
  for (const row of items) {
    const click = `agentbox://thread/${row.id}?project=${encodeURIComponent(row.project)}`;
    await fetchImpl(`${url.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        Title: row.title.slice(0, 80),
        Priority: 'high',
        Tags: 'agentbox',
        Click: click,
      },
      body: row.question.slice(0, 500),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
}

export async function handleRelay(
  req: Request,
  store: RelayStore,
  env: RelayEnv,
  device: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/health' && req.method === 'GET') {
    return json({ ok: true });
  }

  const mac = path.startsWith('/mac/');
  const client = path.startsWith('/client/');
  if (!mac && !client) return json({ error: 'not found' }, 404);
  if (mac && !token(req, 'mac', env)) return unauthorized();
  if (client && !token(req, 'client', env)) return unauthorized();

  if (mac && path === '/mac/project' && req.method === 'PUT') {
    const body = await req.json() as { project: string; name: string; cloud?: boolean };
    if (!body.project || !body.name) return bad('project and name required');
    store.putProject(device, body.project, body.name, body.cloud);
    return json({ ok: true });
  }

  if (mac && path === '/mac/project' && req.method === 'DELETE') {
    const slug = url.searchParams.get('project');
    if (!slug) return bad('project required');
    store.dropProject(device, slug);
    return json({ ok: true });
  }

  if (mac && path === '/mac/threads' && req.method === 'PUT') {
    const body = await req.json() as { project: string; threads: { item: string; snapshot: unknown }[] };
    if (!body.project || !Array.isArray(body.threads)) return bad('project and threads required');
    store.putThreads(device, body.project, body.threads);
    const fresh = store.freshNeedsYou();
    const topic = store.data.ntfy?.topic ?? env.NTFY_TOPIC;
    const ntfyUrl = store.data.ntfy?.url ?? env.NTFY_URL ?? 'https://ntfy.sh';
    if (fresh.length && topic) {
      store.markNotified(fresh);
      await ntfyNotify(fresh, topic, ntfyUrl, fetchImpl);
    }
    return json({ ok: true, notified: fresh.length });
  }

  if (mac && path === '/mac/threads' && req.method === 'DELETE') {
    const project = url.searchParams.get('project');
    const items = url.searchParams.getAll('item');
    if (!project || !items.length) return bad('project and item required');
    store.dropThreads(device, project, items);
    return json({ ok: true });
  }

  if (mac && path === '/mac/status' && req.method === 'PUT') {
    const body = await req.json() as RelayMacStatus;
    store.setStatus(device, body);
    return json({ ok: true });
  }

  if (mac && path === '/mac/settings' && req.method === 'PUT') {
    const body = await req.json() as { settings: unknown; ntfy?: { url: string; topic: string } };
    store.setSettings(device, body.settings, body.ntfy);
    return json({ ok: true });
  }

  if (mac && path === '/mac/commands' && req.method === 'GET') {
    return json({ commands: store.waitingCommands(device) });
  }

  const claimMatch = path.match(/^\/mac\/commands\/([^/]+)\/claim$/);
  if (mac && claimMatch && req.method === 'POST') {
    return json({ claim: store.claimCommand(claimMatch[1]) });
  }

  const doneMatch = path.match(/^\/mac\/commands\/([^/]+)\/done$/);
  if (mac && doneMatch && req.method === 'POST') {
    const body = await req.json() as { outcome: string };
    if (!body.outcome) return bad('outcome required');
    return json({ ok: store.markCommand(doneMatch[1], body.outcome) });
  }

  if (client && path === '/client/needs-you' && req.method === 'GET') {
    return json({ items: store.needsYou() });
  }

  if (client && path === '/client/status' && req.method === 'GET') {
    return json(store.clientStatus());
  }

  if (client && path === '/client/projects' && req.method === 'GET') {
    return json({ projects: store.projectsList() });
  }

  const threadMatch = path.match(/^\/client\/threads\/([^/]+)\/([^/]+)$/);
  if (client && threadMatch && req.method === 'GET') {
    const snap = store.thread(threadMatch[1], threadMatch[2]);
    if (!snap) return json({ error: 'not found' }, 404);
    return json({ snapshot: snap });
  }

  if (client && path === '/client/commands' && req.method === 'POST') {
    const body = await req.json() as RelayCommandIn & { id?: string };
    const id = body.id ?? crypto.randomUUID();
    const why = store.addCommand(device, { ...body, id, project: body.project ?? undefined, item: body.item ?? undefined });
    if (why) return bad(why);
    return json({ id, ok: true });
  }

  return json({ error: 'not found' }, 404);
}
