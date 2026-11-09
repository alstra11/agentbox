import type { RelayEnv } from './env.ts';

export type RelayClientSource = 'iphone' | 'watch';

export type RelayAuthOk =
  | { ok: true; role: 'mac' }
  | { ok: true; role: 'client'; source: RelayClientSource };

export type RelayAuthResult = RelayAuthOk | { ok: false };

/** Constant-time compare so token length does not leak which guess was closer. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const got = m?.[1]?.trim();
  return got || null;
}

/** Mac routes accept only MAC_TOKEN; client routes only IPHONE_TOKEN or WATCH_TOKEN. */
export function authorize(req: Request, env: RelayEnv, side: 'mac' | 'client'): RelayAuthResult {
  const got = bearer(req);
  if (!got) return { ok: false };
  const mac = env.MAC_TOKEN ?? '';
  const iphone = env.IPHONE_TOKEN ?? '';
  const watch = env.WATCH_TOKEN ?? '';
  if (side === 'mac') {
    if (timingSafeEqual(got, iphone) || timingSafeEqual(got, watch)) return { ok: false };
    return timingSafeEqual(got, mac) ? { ok: true, role: 'mac' } : { ok: false };
  }
  if (timingSafeEqual(got, mac)) return { ok: false };
  if (timingSafeEqual(got, iphone)) return { ok: true, role: 'client', source: 'iphone' };
  if (timingSafeEqual(got, watch)) return { ok: true, role: 'client', source: 'watch' };
  return { ok: false };
}
