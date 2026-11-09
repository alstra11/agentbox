// THE RELAY REJECTS CROSS-DEVICE TOKENS.
//
// iPhone and Watch tokens must not reach /mac/*; the Mac token must not reach
// /client/*. Measured on relay/src/auth.ts and handleRelay.
import { describe, it, expect } from 'vitest';
import { authorize, timingSafeEqual } from '../relay/src/auth.ts';
import { RelayStore } from '../relay/src/relay-store.ts';
import { handleRelay } from '../relay/src/http.ts';

const env = { MAC_TOKEN: 'mac-secret-long', IPHONE_TOKEN: 'iphone-secret', WATCH_TOKEN: 'watch-secret' };

describe('authorize', () => {
  const req = (token: string) => new Request('https://x', { headers: { authorization: `Bearer ${token}` } });

  it('accepts only the Mac token on Mac routes', () => {
    expect(authorize(req(env.MAC_TOKEN), env, 'mac')).toEqual({ ok: true, role: 'mac' });
    expect(authorize(req(env.IPHONE_TOKEN), env, 'mac')).toEqual({ ok: false });
    expect(authorize(req(env.WATCH_TOKEN), env, 'mac')).toEqual({ ok: false });
  });

  it('accepts iPhone or Watch tokens on client routes, not Mac', () => {
    expect(authorize(req(env.MAC_TOKEN), env, 'client')).toEqual({ ok: false });
    expect(authorize(req(env.IPHONE_TOKEN), env, 'client')).toEqual({ ok: true, role: 'client', source: 'iphone' });
    expect(authorize(req(env.WATCH_TOKEN), env, 'client')).toEqual({ ok: true, role: 'client', source: 'watch' });
  });

  it('compares secrets in constant time', () => {
    expect(timingSafeEqual('ab', 'ab')).toBe(true);
    expect(timingSafeEqual('ab', 'ac')).toBe(false);
    expect(timingSafeEqual('a', 'ab')).toBe(false);
  });
});

describe('handleRelay', () => {
  it('records source on queued commands', async () => {
    const store = new RelayStore();
    store.putProject('dev', 'alpha', 'Alpha');
    store.putThreads('dev', 'alpha', [{ item: 'w-1', snapshot: { item: { id: 'w-1', status: 'blocked', updatedAt: 1 } } }]);
    const res = await handleRelay(
      new Request('https://x/client/commands', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.WATCH_TOKEN}`, 'content-type': 'application/json', 'x-agentbox-device': 'dev' },
        body: JSON.stringify({ kind: 'reply', project: 'alpha', item: 'w-1', payload: { text: 'ok' } }),
      }),
      store,
      env,
      'dev',
    );
    expect(res.status).toBe(200);
    const list = store.waitingCommands('dev');
    expect(list[0]?.source).toBe('watch');
  });

  it('returns 401 when the Mac token hits a client route', async () => {
    const res = await handleRelay(
      new Request('https://x/client/needs-you', { headers: { authorization: `Bearer ${env.MAC_TOKEN}` } }),
      new RelayStore(),
      env,
      'dev',
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when an iPhone token hits a Mac route', async () => {
    const res = await handleRelay(
      new Request('https://x/mac/commands', { headers: { authorization: `Bearer ${env.IPHONE_TOKEN}` } }),
      new RelayStore(),
      env,
      'dev',
    );
    expect(res.status).toBe(401);
  });
});
