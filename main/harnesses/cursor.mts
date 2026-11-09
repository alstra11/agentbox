import path from 'node:path';
import type { EventEmitter } from 'node:events';
import { harnessDefinition } from '../../shared/harness-definitions.mts';
import { definitionMethods, commonUpdatePlan } from './common.mts';
import type { BinKey, Env, HarnessPlan, HarnessRecord, HarnessSession, HarnessSpawnContext, HarnessSupervisor, SignInFilesWhere, UpdatePlanOptions } from './common.mts';
import type { InstructionsContext } from './instructions-file.mts';
import { resolveCursorBin, cursorSignedIn, cursorModelRows, cursorCredentialPath, cursorProfileHome } from '../cursor-bin.mts';
import { createCursorWorker } from '../cursor-worker.mts';
import type { CursorWorker } from '../cursor-worker.mts';
import {
  captureCursorUpdate, cursorStreamingText, summarizeCursorUpdate, traceCursorUpdate, cursorActivity,
} from '../cursor.mts';
import { instructionsFor } from './instructions-file.mts';

const definition = harnessDefinition('cursor')!;

export const cursorHarness = {
  ...definitionMethods(definition),

  discover: resolveCursorBin,

  signedIn: (_sup: HarnessSupervisor, _profile: string) => cursorSignedIn(),
  profiles: () => ['default'],
  profileHome: (_sup: HarnessSupervisor, profile: string) => (profile && profile !== 'default' ? profile : null),
  profileEnv: (env: Env, profile: string) => (profile && profile !== 'default' ? { ...env, [definition.homeEnv]: profile } : env),
  accountKey: () => `${definition.accountPrefix}default`,
  signInFiles: ({ home }: SignInFilesWhere) => [cursorCredentialPath(home)],

  models: ({ bin }: { bin?: string | null } = {}) => cursorModelRows(bin ?? null),
  defaultModel: () => null,
  workspaceModel: () => null,
  effortLevels: () => ({ supported: false, engine: definition.id, capability: 'effortLevels' }),
  usage: () => ({ supported: false, engine: definition.id, capability: 'usage' }),

  tooling: () => null,
  instructions: (context?: InstructionsContext) => instructionsFor({ ...definition, instructions: { file: 'AGENTS.md', in: 'home' } }, context),

  spawn: (sup: HarnessSupervisor, plan: HarnessPlan, context: HarnessSpawnContext) =>
    sup._spawnCursorWorker(plan, context),

  readers: () => ({
    capture: captureCursorUpdate,
    stream: cursorStreamingText,
    summarize: summarizeCursorUpdate,
    trace: traceCursorUpdate,
    activity: cursorActivity,
  }),

  subscribe(child: EventEmitter, session: HarnessSession, absorb: (method: string, params: unknown) => void): void {
    child.on('event', (method: string, params: unknown) => absorb(method, params));
  },

  transcript: () => null,
  change: (session: HarnessSession | null | undefined) => {
    const files = (session as { cursorChange?: string[] } | null | undefined)?.cursorChange;
    return files?.length ? { files: [...files] } : null;
  },
  release: () => {},

  settleApproval: (sup: HarnessSupervisor, id: string, allow: boolean, note?: string | null) =>
    sup.settleCursorApproval(id, allow, note),
  approvalChanged: (sup: HarnessSupervisor, id: string, shown: unknown) =>
    sup.cursorCardChanged(id, shown),

  memoryGate: () => ({}),
  updatePlan: (options: UpdatePlanOptions) => commonUpdatePlan(definition, options),
  updateSettings: () => ({}),
  smallModelArgs: (prompt: string, model?: string | null) => ['-p', prompt, ...(model ? ['--model', model] : [])],
};

export type { CursorWorker };
