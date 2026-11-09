// THE RELAY QUEUES A COMMAND THE MAC CAN CLAIM.
//
// A watch client sent a reply while the Mac was asleep; when the relay handler
// runs, the Mac token can list it, claim it, and mark it done. Measured with
// the in-memory RelayStore, no network.
import { describe, it, expect, vi } from 'vitest';
import { RelayStore } from '../relay/src/relay-store.ts';
import { handleRelay, ntfyNotify } from '../relay/src/http.ts';

const env = { MAC_TOKEN: 'mac-secret', IPHONE_TOKEN: 'iphone-secret', WATCH_TOKEN: 'watch-secret', NTFY_TOPIC: 'home' };
const device = 'abcabcabcabc';

describe('the relay command queue', () => {
  it('refuses a client without the token', async () => {
    const store = new RelayStore();
    const res = await handleRelay(new Request('https://x/client/needs-you'), store, env, device);
    expect(res.status).toBe(401);
  });

  it('queues a reply after a snapshot exists, then lets the Mac claim it', async () => {
    const store = new RelayStore();
    store.putProject(device, 'alpha', 'Alpha');
    store.putThreads(device, 'alpha', [{
      item: 'w-abc1234567',
      snapshot: { item: { id: 'w-abc1234567', title: 'Ship?', status: 'blocked', kind: 'question', updatedAt: 1 } },
    }]);
    let res = await handleRelay(
      new Request('https://x/client/commands', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.IPHONE_TOKEN}`,
          'content-type': 'application/json',
          'x-agentbox-device': device,
        },
        body: JSON.stringify({ kind: 'reply', project: 'alpha', item: 'w-abc1234567', payload: { text: 'Ship it' } }),
      }),
      store,
      env,
      device,
      vi.fn(),
    );
    expect(res.status).toBe(200);
    const queued = store.waitingCommands(device)[0];
    expect(queued?.source).toBe('iphone');
    res = await handleRelay(
      new Request('https://x/mac/commands', {
        headers: { authorization: `Bearer ${env.MAC_TOKEN}`, 'x-agentbox-device': device },
      }),
      store,
      env,
      device,
      vi.fn(),
    );
    const list = await res.json() as { commands: { id: string; kind: string; source: string }[] };
    expect(list.commands).toHaveLength(1);
    expect(list.commands[0].source).toBe('iphone');
    const id = list.commands[0].id;
    const claim = await handleRelay(
      new Request(`https://x/mac/commands/${id}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.MAC_TOKEN}`, 'x-agentbox-device': device },
      }),
      store,
      env,
      device,
      vi.fn(),
    );
    expect((await claim.json() as { claim: string }).claim).toBe('claimed');
  });

  it('sends ntfy once per new needs-you stamp', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const store = new RelayStore();
    store.putProject(device, 'alpha', 'Alpha');
    await handleRelay(
      new Request('https://x/mac/threads', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${env.MAC_TOKEN}`,
          'content-type': 'application/json',
          'x-agentbox-device': device,
        },
        body: JSON.stringify({
          project: 'alpha',
          threads: [{ item: 'w-1', snapshot: { item: { id: 'w-1', title: 'Pick one', status: 'blocked', kind: 'question', body: '## Options\n1. Yes (recommended)\n2. No', updatedAt: 10 } } }],
        }),
      }),
      store,
      env,
      device,
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await handleRelay(
      new Request('https://x/mac/threads', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${env.MAC_TOKEN}`,
          'content-type': 'application/json',
          'x-agentbox-device': device,
        },
        body: JSON.stringify({
          project: 'alpha',
          threads: [{ item: 'w-1', snapshot: { item: { id: 'w-1', title: 'Pick one', status: 'blocked', kind: 'question', body: '## Options\n1. Yes (recommended)\n2. No', updatedAt: 10 } } }],
        }),
      }),
      store,
      env,
      device,
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ntfyNotify', () => {
  it('uses agentbox deep links', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    await ntfyNotify([{ id: 'w-99', title: 'T', question: 'Q?', project: 'alpha' }], 'topic', 'https://ntfy.sh', fetchMock);
    expect(fetchMock.mock.calls[0][0]).toBe('https://ntfy.sh/topic');
    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers as HeadersInit);
    expect(headers.get('Click')).toMatch(/agentbox:\/\/thread\/w-99/);
  });
});
