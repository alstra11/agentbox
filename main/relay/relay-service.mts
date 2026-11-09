// Opt-in relay mode: snapshots up, commands down, without cloud sign-in.

import path from 'node:path';
import { phoneEligible, phoneProjectsOf, phoneWaitsOf, SNAPSHOT_LIMITS } from '../../shared/phone-snapshot.mts';
import type { ChannelResult, PhoneCommand, PhoneHistoryLine, PhoneItem } from '../phone-inbox.mts';
import type { RelayConfig } from '../../shared/relay-types.mts';
import { createPhoneInbox } from '../phone-inbox.mts';
import { phoneDevice } from '../phone-inbox.mts';
import type { SettingsModel } from '../../shared/phone-settings.mts';
import { relayBackend, relayPutStatus } from './relay-backend.mts';
import { relayHarnesses } from '../../shared/relay-harnesses.mts';

const SYNC_MS = 30_000;

export interface RelayServiceHooks {
  config: { accountId?: string; home?: string; storeRoot: string; phoneProducts?: unknown; relay?: unknown; [key: string]: unknown };
  appDir: string;
  storeRoot: string;
  products: () => { slug: string; name: string; dir?: string | null; repoPath?: string | null }[];
  listItems: (slug: string) => unknown[];
  historyOf: (slug: string, id: string, opts?: { all?: boolean }) => unknown[];
  apply: (cmd: unknown) => Promise<unknown>;
  readSettings: (() => SettingsModel | Promise<SettingsModel | null> | null) | null;
  liveOf: (slug: string, id: string) => unknown;
  waitsOf: () => ReturnType<typeof phoneWaitsOf>;
  approvalsOf: () => unknown[];
  pinsOf: () => Record<string, boolean>;
  onMacOf: () => Record<string, boolean>;
  version: string;
  log?: (line: string) => void;
  hostname?: string;
}

function relayOn(config: RelayServiceHooks['config']): RelayConfig | null {
  const raw = config.relay;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.on === false) return null;
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  const macToken = typeof r.macToken === 'string' ? r.macToken : '';
  if (!url || !macToken) return null;
  return {
    url,
    macToken,
    ntfyUrl: typeof r.ntfyUrl === 'string' ? r.ntfyUrl : undefined,
    ntfyTopic: typeof r.ntfyTopic === 'string' ? r.ntfyTopic : undefined,
    projects: Array.isArray(r.projects) ? r.projects.filter((s): s is string => typeof s === 'string') : undefined,
  };
}

export function startRelayService(hooks: RelayServiceHooks) {
  const relay = relayOn(hooks.config);
  if (!relay) return { stop: () => {} };

  const device = phoneDevice(hooks.appDir, hooks.storeRoot);
  const owner = hooks.config.accountId!;
  if (!owner) throw new Error('relay needs accountId in zero.config.json');
  const every = phoneEligible(hooks.products());
  const chosen = relay.projects?.length
    ? { owner, all: false, except: every.filter((s) => !relay.projects!.includes(s)) }
    : hooks.config.phoneProducts ?? { owner, all: true, except: [] as string[] };

  const backend = relayBackend({
    baseUrl: relay.url,
    macToken: relay.macToken,
    device,
    owner,
    ntfy: relay.ntfyTopic ? { url: relay.ntfyUrl ?? 'https://ntfy.sh', topic: relay.ntfyTopic } : undefined,
  });

  const inbox = createPhoneInbox({
    backend,
    owner,
    device,
    projects: () => {
      const on = new Set(phoneProjectsOf(chosen, owner, every));
      return hooks.products().filter((p) => on.has(p.slug)).map((p) => ({
        slug: p.slug,
        name: p.name || p.slug,
        dir: p.dir ?? null,
        repoPath: p.repoPath ?? null,
      }));
    },
    listItems: (slug) => hooks.listItems(slug) as PhoneItem[],
    historyOf: (slug, id, opts) => hooks.historyOf(slug, id, opts) as PhoneHistoryLine[],
    apply: (cmd) => hooks.apply(cmd) as Promise<ChannelResult | null | undefined>,
    stateFile: path.join(hooks.storeRoot, `.relay-inbox.${owner}.json`),
    home: hooks.config.home ?? undefined,
    log: hooks.log ?? ((l) => console.log(l)),
    liveOf: hooks.liveOf as never,
    waitsOf: () => hooks.waitsOf(),
    approvalsOf: () => hooks.approvalsOf() as never,
    readSettings: hooks.readSettings,
    pinsOf: () => hooks.pinsOf(),
    onMacOf: () => hooks.onMacOf(),
    version: hooks.version,
    name: hooks.hostname,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const pass = async () => {
    if (stopped) return;
    const status = hooks.waitsOf();
    try {
      await relayPutStatus({
        baseUrl: relay.url,
        macToken: relay.macToken,
        device,
        owner,
      }, {
        at: Date.now(),
        paused: status.paused,
        stalled: Object.entries(status.byId ?? {}).filter(([, v]) => v.state === 'stalled').map(([id]) => id),
        queued: Object.entries(status.byId ?? {}).filter(([, v]) => v.state === 'queued' || v.state === 'next').map(([id]) => id),
        runNow: Object.entries(status.byId ?? {}).filter(([, v]) => v.state === 'next').map(([id]) => id),
        version: hooks.version,
        computerName: hooks.hostname,
        harnesses: relayHarnesses(),
      });
    } catch (err) {
      console.warn(`relay: status: ${(err as Error).message}`);
    }
    try {
      await inbox.syncOnce();
    } catch (err) {
      console.warn(`relay: sync: ${(err as Error).message}`);
    }
  };

  void pass();
  timer = setInterval(() => { void pass(); }, SYNC_MS);

  return {
    stop: () => { stopped = true; if (timer) clearInterval(timer); timer = null; },
    arrivals: (list: unknown[], needsYou: unknown[]) => inbox.arrivals(list, needsYou),
  };
}
