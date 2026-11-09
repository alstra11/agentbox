// Shapes the Cloudflare relay and the Mac client agree on. Browser-safe.

import type { PhoneCommandSeen } from './phone-snapshot.mts';

export interface RelayConfig {
  url: string;
  macToken: string;
  ntfyUrl?: string;
  ntfyTopic?: string;
  /** Projects on the relay; default is every non-practice product when unset. */
  projects?: string[];
}

export interface RelayMacStatus {
  at: number;
  paused?: boolean;
  stalled?: string[];
  queued?: string[];
  runNow?: string[];
  version?: string;
  computerName?: string;
  harnesses?: { id: string; label: string }[];
}

export interface RelayClientOption {
  n: number;
  text: string;
  recommended: boolean;
}

export interface RelayNeedsYouItem {
  project: string;
  projectName: string;
  id: string;
  title: string;
  status: string;
  kind?: string;
  updatedAt: number;
  context: string;
  question: string;
  options: RelayClientOption[];
  hasApproval?: boolean;
  wait?: { state: string; tool?: string; until?: number };
  /** `cloud` or `local`. Absent on a relay that does not steer cloud agents. */
  target?: 'cloud' | 'local';
  /** Cloud provider id (`cursor`) or, for local, the computer name. */
  provider?: string;
}

export interface RelayHarness {
  id: string;
  label: string;
  available: boolean;
}

export interface RelayClientStatus {
  macLastSeen: number | null;
  macOnline: boolean;
  paused: boolean;
  stalled: string[];
  queue: { runNow: string[]; queued: string[] };
  version?: string;
  computerName?: string;
  harnesses: RelayHarness[];
}

export interface RelayTargetChoice {
  target: 'cloud' | 'local';
  provider: string;
  label: string;
  available: boolean;
}

export interface RelayTargets {
  macOnline: boolean;
  computerName: string | null;
  defaultTarget: 'cloud';
  harnesses: RelayHarness[];
  targets: RelayTargetChoice[];
}

export interface RelayCommandIn extends PhoneCommandSeen {
  id?: string;
}

export const RELAY_DEADLINE_MS = 15_000;
