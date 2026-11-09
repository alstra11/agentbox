// The local engines the Mac reports on its heartbeat. Admitted engines only,
// so a harness that is registered but not offered (OpenCode) stays off the phone.
import { ENGINES } from './engines.mts';

export interface RelayHarnessName {
  id: string;
  label: string;
}

export function relayHarnesses(): RelayHarnessName[] {
  return ENGINES.map(({ id, label }) => ({ id, label }));
}
