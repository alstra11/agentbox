// In-memory relay state; the Durable Object wraps this.

import { checkCommand, PHONE_COMMANDS } from '../../shared/phone-snapshot.mts';
import { needsYouFromSnapshot, macOnlineAt } from '../../shared/relay-needs-you.mts';
import type { RelayClientStatus, RelayCommandIn, RelayMacStatus, RelayNeedsYouItem } from '../../shared/relay-types.mts';

export type RelayCommandSource = 'iphone' | 'watch';

export interface PhoneCommandRow {
  id: string;
  device: string;
  source: RelayCommandSource;
  project: string | null;
  item: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  claimedAt: string | null;
  takenAt: string | null;
  outcome: string | null;
}

export interface RelayStoreData {
  projects: Record<string, { name: string; cloud?: boolean; updatedAt: number }>;
  threads: Record<string, { project: string; item: string; snapshot: unknown; updatedAt: number }>;
  commands: PhoneCommandRow[];
  status: RelayMacStatus | null;
  settings: unknown;
  notified: Record<string, string>;
  ntfy?: { url: string; topic: string };
}

const threadKey = (project: string, item: string) => `${project}:${item}`;

export class RelayStore {
  data: RelayStoreData;

  constructor(seed?: Partial<RelayStoreData>) {
    this.data = {
      projects: {},
      threads: {},
      commands: [],
      status: null,
      settings: null,
      notified: {},
      ...seed,
    };
  }

  putProject(device: string, project: string, name: string, cloud?: boolean, now = Date.now()) {
    void device;
    this.data.projects[project] = { name, cloud: !!cloud, updatedAt: now };
  }

  dropProject(device: string, project: string) {
    void device;
    delete this.data.projects[project];
    for (const k of Object.keys(this.data.threads)) {
      if (this.data.threads[k].project === project) delete this.data.threads[k];
    }
  }

  putThreads(device: string, project: string, rows: { item: string; snapshot: unknown }[], now = Date.now()) {
    void device;
    for (const { item, snapshot } of rows) {
      this.data.threads[threadKey(project, item)] = { project, item, snapshot, updatedAt: now };
    }
  }

  dropThreads(device: string, project: string, items: string[]) {
    void device;
    for (const item of items) delete this.data.threads[threadKey(project, item)];
  }

  setStatus(device: string, status: RelayMacStatus) {
    void device;
    this.data.status = status;
  }

  setSettings(device: string, settings: unknown, ntfy?: { url: string; topic: string }) {
    void device;
    this.data.settings = settings;
    if (ntfy?.url && ntfy?.topic) this.data.ntfy = ntfy;
  }

  waitingCommands(device: string): PhoneCommandRow[] {
    return this.data.commands
      .filter((c) => c.device === device && !c.takenAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  claimCommand(id: string): 'claimed' | 'gone' | 'ours' {
    const row = this.data.commands.find((c) => c.id === id);
    if (!row || row.takenAt) return 'gone';
    if (row.claimedAt) return 'ours';
    row.claimedAt = new Date().toISOString();
    return 'claimed';
  }

  markCommand(id: string, outcome: string): boolean {
    const row = this.data.commands.find((c) => c.id === id);
    if (!row || row.takenAt) return false;
    row.takenAt = new Date().toISOString();
    row.outcome = outcome;
    return true;
  }

  addCommand(device: string, cmd: RelayCommandIn & { id: string }, source: RelayCommandSource): string | null {
    const projects = Object.keys(this.data.projects);
    const hasItem = (project: string, item: string) => Boolean(this.data.threads[threadKey(project, item)]);
  const why = checkCommand(cmd, { projects, hasItem });
    if (why) return why;
    if (!PHONE_COMMANDS.includes(cmd.kind)) return 'not something the phone may do';
    if (this.data.commands.some((c) => c.id === cmd.id)) return 'already there';
    this.data.commands.push({
      id: cmd.id,
      device,
      source,
      project: cmd.project ?? null,
      item: cmd.item ?? null,
      kind: cmd.kind,
      payload: (cmd.payload ?? {}) as Record<string, unknown>,
      createdAt: new Date().toISOString(),
      claimedAt: null,
      takenAt: null,
      outcome: null,
    });
    return null;
  }

  needsYou(now = Date.now()): RelayNeedsYouItem[] {
    const stalled = new Set(this.data.status?.stalled ?? []);
    const out: RelayNeedsYouItem[] = [];
    for (const row of Object.values(this.data.threads)) {
      const proj = this.data.projects[row.project];
      if (!proj) continue;
      const item = needsYouFromSnapshot(row.project, proj.name, row.snapshot as { item?: unknown }, this.data.status, stalled);
      if (item) out.push(item);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  clientStatus(now = Date.now()): RelayClientStatus {
    const last = this.data.status?.at ?? null;
    return {
      macLastSeen: last,
      macOnline: macOnlineAt(last, now),
      paused: !!this.data.status?.paused,
      stalled: this.data.status?.stalled ?? [],
      queue: { runNow: this.data.status?.runNow ?? [], queued: this.data.status?.queued ?? [] },
      version: this.data.status?.version,
      computerName: this.data.status?.computerName,
    };
  }

  thread(project: string, item: string) {
    return this.data.threads[threadKey(project, item)]?.snapshot ?? null;
  }

  projectsList() {
    return Object.entries(this.data.projects).map(([slug, p]) => ({ slug, name: p.name, cloud: !!p.cloud, updatedAt: p.updatedAt }));
  }

  /** Newly needing you since last notify; updates notified map when applied. */
  freshNeedsYou(now = Date.now()): RelayNeedsYouItem[] {
    const items = this.needsYou(now);
    const fresh: RelayNeedsYouItem[] = [];
    for (const row of items) {
      const key = threadKey(row.project, row.id);
      const stamp = `${row.status}:${row.updatedAt}:${row.question}`;
      if (this.data.notified[key] === stamp) continue;
      fresh.push(row);
    }
    return fresh;
  }

  markNotified(items: RelayNeedsYouItem[]) {
    for (const row of items) {
      const key = threadKey(row.project, row.id);
      const stamp = `${row.status}:${row.updatedAt}:${row.question}`;
      this.data.notified[key] = stamp;
    }
  }

  toJSON(): RelayStoreData {
    return this.data;
  }

  static fromJSON(raw: RelayStoreData) {
    return new RelayStore(raw);
  }
}
