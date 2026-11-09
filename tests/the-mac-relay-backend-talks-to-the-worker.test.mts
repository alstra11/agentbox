// THE MAC RELAY BACKEND TALKS TO THE WORKER.
//
// relayBackend must PUT thread batches with the Mac bearer token and device
// header. Measured with a stub fetch.
import { describe, it, expect, vi } from 'vitest';
import { relayBackend } from '../main/relay/relay-backend.mts';

describe('relayBackend', () => {
  it('sends snapshots to /mac/threads', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const backend = relayBackend({
      baseUrl: 'https://agents.alstra11.workers.dev',
      macToken: 'mac-tok',
      device: 'abcabcabcabc',
      owner: 'owner-1',
      fetch: fetchMock,
    });
    await backend.putPhoneProject!({ owner: 'owner-1', device: 'abcabcabcabc', project: 'alpha', name: 'Alpha' });
    await backend.putPhoneThreads!('abcabcabcabc', 'alpha', [{ item: 'w-1', snapshot: { v: 3, item: { id: 'w-1' }, history: [], olderLines: 0 } }], 'owner-1');
    const threadCall = seen.find((s) => s.url.endsWith('/mac/threads'));
    expect(threadCall).toBeTruthy();
    const headers = new Headers(threadCall!.init.headers as HeadersInit);
    expect(headers.get('authorization')).toBe('Bearer mac-tok');
    expect(headers.get('x-agentbox-device')).toBe('abcabcabcabc');
  });
});
