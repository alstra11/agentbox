import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findEngine, type EngineSearch } from './engine-bin.mts';
import { signInStamp } from './sign-in-files.mts';

export function resolveCursorBin(configured: string | null | undefined = null): EngineSearch {
  return findEngine('cursor', { configured });
}

export function cursorSignedIn(home: string = os.homedir()): boolean {
  return signInStamp([cursorCredentialPath(home)]) > 0;
}

export function cursorModelRows(_bin?: string | null): { supported: false; engine: string; capability: string } {
  return { supported: false, engine: 'cursor', capability: 'models' };
}

export function cursorProfileHome(home: string = os.homedir()): string {
  return path.join(home, '.cursor');
}

export function cursorCredentialPath(home: string = os.homedir()): string {
  const dir = cursorProfileHome(home);
  const auth = path.join(dir, 'auth.json');
  return fs.existsSync(auth) ? auth : path.join(dir, 'cli-config.json');
}
