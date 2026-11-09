// Which snapshot rows belong in Needs you for the relay client — a narrow slice of list-rules.

import { itemOptions, optionsFrom } from './relay-options.mts';
import { relayQuestion } from './relay-ask.mts';
import type { RelayClientOption, RelayMacStatus, RelayNeedsYouItem } from './relay-types.mts';

interface SnapshotItem {
  id?: unknown;
  title?: unknown;
  body?: unknown;
  result?: unknown;
  note?: unknown;
  kind?: unknown;
  status?: unknown;
  answer?: unknown;
  updatedAt?: unknown;
  wrote?: Record<string, { ts: number; source: string } | undefined>;
}

interface ThreadSnapshotSeen {
  item?: SnapshotItem;
  approvals?: { id: string; tool: string }[];
  wait?: { state: string; tool?: string; until?: number };
}

const liveAnswer = (i: SnapshotItem) => (typeof i.answer === 'string' && i.answer && i.answer !== '(withdrawn)' ? i.answer : undefined);

function stillAsksYou(i: SnapshotItem): boolean {
  if (i.kind !== 'question' && i.kind !== 'review') return false;
  if (i.status === 'done') return false;
  return !liveAnswer(i);
}

/** Enough to steer from a phone; not a full inbox fold. */
export function needsYouFromSnapshot(
  project: string,
  projectName: string,
  snapshot: ThreadSnapshotSeen,
  status: RelayMacStatus | null,
  stalled: Set<string>,
): RelayNeedsYouItem | null {
  const item = snapshot.item;
  if (!item || typeof item.id !== 'string') return null;
  const id = item.id;
  const asking = (snapshot.approvals?.length ?? 0) > 0;
  const stopped = stalled.has(id);
  const statusStr = String(item.status ?? '');
  let inNeedsYou = asking || stopped;
  if (!inNeedsYou && stillAsksYou(item)) inNeedsYou = true;
  if (!inNeedsYou && statusStr === 'blocked') inNeedsYou = true;
  if (!inNeedsYou && statusStr === 'open' && item.kind !== 'question' && item.kind !== 'review' && !liveAnswer(item)) {
    const hers = item.wrote?.title?.source === 'founder' || item.wrote?.body?.source === 'founder';
    if (!hers) inNeedsYou = true;
  }
  if (!inNeedsYou) return null;

  const fields = item as { result?: string; note?: string; body?: string; title?: string; wrote?: Record<string, { ts: number } | undefined> };
  const field = optionsFrom(fields);
  const options: RelayClientOption[] = itemOptions(fields).map((o) => ({ n: o.n, text: o.text.replace(/\s*\(recommended\)\s*/i, '').trim(), recommended: o.recommended }));
  const context = typeof item.body === 'string' ? item.body.slice(0, 400) : '';
  const question = asking
    ? (snapshot.approvals?.[0]?.tool ? `Allow ${snapshot.approvals[0].tool}?` : 'Permission needed')
    : relayQuestion(fields, field);

  return {
    project,
    projectName,
    id,
    title: String(item.title ?? id).slice(0, 200),
    status: statusStr,
    kind: typeof item.kind === 'string' ? item.kind : undefined,
    updatedAt: Number(item.updatedAt) || 0,
    context: context.length > 400 ? `${context.slice(0, 399)}…` : context,
    question,
    options,
    hasApproval: asking,
    ...(snapshot.wait ? { wait: snapshot.wait } : {}),
  };
}

/** A heartbeat is about every 30s. Three missed beats and the Mac counts as off. */
export const MAC_ONLINE_MS = 90_000;

export function macOnlineAt(lastSeen: number | null, now: number): boolean {
  if (!lastSeen) return false;
  return now - lastSeen < MAC_ONLINE_MS;
}
