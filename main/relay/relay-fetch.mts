import { RELAY_DEADLINE_MS } from '../../shared/relay-types.mts';

export async function relayFetch(
  url: string,
  init: RequestInit & { token: string },
  { deadlineMs = RELAY_DEADLINE_MS, fetchImpl = fetch }: { deadlineMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${init.token}`);
  return fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(deadlineMs) });
}
