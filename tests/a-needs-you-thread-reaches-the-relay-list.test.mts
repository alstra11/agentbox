// A NEEDS-YOU THREAD REACHES THE RELAY LIST.
//
// The relay client reads blocked questions with parsed options. Measured on
// shared/relay-needs-you.mts without the worker.
import { describe, it, expect } from 'vitest';
import { needsYouFromSnapshot } from '../shared/relay-needs-you.mts';

describe('needsYouFromSnapshot', () => {
  it('lists a blocked question with options and a short question line', () => {
    const row = needsYouFromSnapshot('alpha', 'Alpha', {
      item: {
        id: 'w-abc',
        title: 'Deploy',
        status: 'blocked',
        kind: 'question',
        body: '**Merge now?**\n\n## Options\n1. Ship it (recommended)\n2. Wait',
        updatedAt: 42,
      },
    }, null, new Set());
    expect(row?.id).toBe('w-abc');
    expect(row?.options).toHaveLength(2);
    expect(row?.options[0].recommended).toBe(true);
    expect(row?.question).toMatch(/merge/i);
  });

  it('ignores done threads', () => {
    const row = needsYouFromSnapshot('alpha', 'Alpha', {
      item: { id: 'w-x', status: 'done', kind: 'question', updatedAt: 1 },
    }, null, new Set());
    expect(row).toBeNull();
  });
});
