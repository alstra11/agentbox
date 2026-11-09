// Phone inbox backend that talks to the agents Cloudflare relay.

import type { PhoneBackendCalls } from '../phone-inbox.mts';
import { relayFetch } from './relay-fetch.mts';

export interface RelayBackendOptions {
  baseUrl: string;
  macToken: string;
  device: string;
  owner: string;
  ntfy?: { url: string; topic: string };
  fetch?: typeof fetch;
}

export function relayBackend({
  baseUrl,
  macToken,
  device,
  owner,
  ntfy,
  fetch: fetchImpl = fetch,
}: RelayBackendOptions): PhoneBackendCalls {
  const root = baseUrl.replace(/\/$/, '');
  const hdrs = { token: macToken, headers: { 'content-type': 'application/json', 'x-agentbox-device': device } };
  const call = async (path: string, init: RequestInit) => {
    const res = await relayFetch(`${root}${path}`, { ...init, ...hdrs }, { fetchImpl });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(body || `relay ${res.status}`);
    }
    return res.json().catch(() => ({}));
  };

  return {
    async putPhoneProject({ project, name, cloud }) {
      await call('/mac/project', { method: 'PUT', body: JSON.stringify({ project, name, cloud }) });
    },
    async dropPhoneProject(_device, slug) {
      await call(`/mac/project?project=${encodeURIComponent(slug)}`, { method: 'DELETE' });
    },
    async putPhoneThreads(_device, slug, threads) {
      await call('/mac/threads', { method: 'PUT', body: JSON.stringify({ project: slug, threads: threads.map(({ item, snapshot }) => ({ item, snapshot })) }) });
    },
    async dropPhoneThreads(_device, slug, items) {
      const q = new URLSearchParams({ project: slug });
      for (const item of items) q.append('item', item);
      await call(`/mac/threads?${q}`, { method: 'DELETE' });
    },
    async putPhoneSettings({ name, settings }) {
      await call('/mac/settings', { method: 'PUT', body: JSON.stringify({ settings: { name, ...settings as object }, ntfy }) });
    },
    async waitingPhoneCommands(_device) {
      const out = await call('/mac/commands', { method: 'GET' }) as { commands?: unknown[] };
      return (out.commands ?? []) as Awaited<ReturnType<NonNullable<PhoneBackendCalls['waitingPhoneCommands']>>>;
    },
    async claimPhoneCommand(id) {
      const out = await call(`/mac/commands/${encodeURIComponent(id)}/claim`, { method: 'POST', body: '{}' }) as { claim: string };
      if (out.claim === 'claimed') return 'claimed';
      if (out.claim === 'ours') return 'ours';
      return 'gone';
    },
    async markPhoneCommand(id, outcome) {
      await call(`/mac/commands/${encodeURIComponent(id)}/done`, { method: 'POST', body: JSON.stringify({ outcome }) });
    },
    async addPhoneCommand() {
      throw new Error('the Mac does not send commands through the relay');
    },
  };
}

export async function relayPutStatus(
  opts: RelayBackendOptions,
  status: Record<string, unknown>,
) {
  const root = opts.baseUrl.replace(/\/$/, '');
  await relayFetch(`${root}/mac/status`, {
    method: 'PUT',
    token: opts.macToken,
    headers: { 'content-type': 'application/json', 'x-agentbox-device': opts.device },
    body: JSON.stringify(status),
  }, { fetchImpl: opts.fetch });
}
