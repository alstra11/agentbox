// In-memory relay state; the Durable Object wraps this.

import { checkCommand, PHONE_COMMANDS } from '../../shared/phone-snapshot.mts';
import { needsYouFromSnapshot, macOnlineAt } from '../../shared/relay-needs-you.mts';
import type { RelayClientStatus, RelayCommandIn, RelayMacStatus, RelayNeedsYouItem, RelayTargets } from '../../shared/relay-types.mts';
import type { AgentSession, SessionNeed } from './session.ts';
import { CLOUD_POLL_MS } from './session.ts';

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
  sessions: Record<string, AgentSession>;
  needs: SessionNeed[];
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
      sessions: {},
      needs: [],
      ...seed,
    };
    if (!this.data.sessions) this.data.sessions = {};
    if (!this.data.needs) this.data.needs = [];
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
    void device;
    return this.data.commands
      .filter((c) => !c.takenAt && this.commandIsLocal(c))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** A cloud session is steered by the relay. The Mac must not claim it. */
  commandIsLocal(row: PhoneCommandRow): boolean {
    if (row.payload?.target === 'cloud') return false;
    if (row.item && this.data.sessions[row.item]?.target === 'cloud') return false;
    return true;
  }

  claimCommand(id: string): 'claimed' | 'gone' | 'ours' {
    const row = this.data.commands.find((c) => c.id === id);
    if (!row || row.takenAt || !this.commandIsLocal(row)) return 'gone';
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
      if (item) {
        item.target = 'local';
        item.provider = this.localMachine();
        out.push(item);
      }
    }
    out.push(...this.cloudNeeds());
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  localMachine(): string {
    const name = this.data.status?.computerName?.trim();
    return name || 'mac';
  }

  cloudNeeds(): RelayNeedsYouItem[] {
    const latest = new Map<string, SessionNeed>();
    for (const need of this.data.needs) {
      if (need.answer) continue;
      latest.set(need.sessionId, need);
    }
    const out: RelayNeedsYouItem[] = [];
    for (const need of latest.values()) {
      const session = this.data.sessions[need.sessionId];
      if (!session || session.target !== 'cloud') continue;
      if (session.status === 'archived' || session.status === 'cancelled') continue;
      const proj = this.data.projects[need.project];
      out.push({
        project: need.project,
        projectName: proj?.name ?? need.project,
        id: session.id,
        title: session.title,
        status: session.status,
        kind: need.kind,
        updatedAt: Date.parse(need.updatedAt) || 0,
        context: (session.result || session.prompt).slice(0, 400),
        question: need.question,
        options: need.options,
        hasApproval: need.kind === 'approval',
        target: 'cloud',
        provider: session.provider,
      });
    }
    return out;
  }

  clientStatus(now = Date.now()): RelayClientStatus {
    const last = this.data.status?.at ?? null;
    const online = macOnlineAt(last, now);
    const listed = this.data.status?.harnesses ?? [];
    return {
      macLastSeen: last,
      macOnline: online,
      paused: !!this.data.status?.paused,
      stalled: this.data.status?.stalled ?? [],
      queue: { runNow: this.data.status?.runNow ?? [], queued: this.data.status?.queued ?? [] },
      version: this.data.status?.version,
      computerName: this.data.status?.computerName,
      harnesses: listed.filter((h) => h && typeof h.id === 'string' && h.id).map((h) => ({
        id: h.id,
        label: typeof h.label === 'string' && h.label ? h.label : h.id,
        available: online,
      })),
    };
  }

  clientTargets(now = Date.now()): RelayTargets {
    const status = this.clientStatus(now);
    const machine = status.computerName?.trim() || 'Mac';
    return {
      macOnline: status.macOnline,
      computerName: status.computerName ?? null,
      defaultTarget: 'cloud',
      harnesses: status.harnesses,
      targets: [
        { target: 'cloud', provider: 'cursor', label: 'Cloud · Cursor', available: true },
        { target: 'local', provider: 'mac', label: `Lokal · ${machine}`, available: status.macOnline },
      ],
    };
  }

  nextCloudAlarm(now: number): number | null {
    const active = Object.values(this.data.sessions).some((s) => (
      s.target === 'cloud'
      && s.status !== 'archived'
      && s.status !== 'cancelled'
      && (s.runActive || s.followUpQueued || Boolean(s.pendingPrompt))
    ));
    return active ? now + CLOUD_POLL_MS : null;
  }

  session(id: string): AgentSession | null {
    return this.data.sessions[id] ?? null;
  }

  sessionByCommand(commandId: string): AgentSession | null {
    return Object.values(this.data.sessions).find((s) => s.commandId === commandId) ?? null;
  }

  saveSession(session: AgentSession) {
    this.data.sessions[session.id] = session;
  }

  addNeed(need: SessionNeed) {
    this.data.needs.push(need);
  }

  hasNeed(sessionId: string, runId: string): boolean {
    return this.data.needs.some((n) => n.sessionId === sessionId && n.runId === runId);
  }

  answerNeed(sessionId: string, answer: string, now: number) {
    const at = new Date(now).toISOString();
    for (const need of this.data.needs) {
      if (need.sessionId === sessionId && !need.answer) {
        need.answer = answer;
        need.updatedAt = at;
      }
    }
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
