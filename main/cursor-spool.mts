import crypto from 'node:crypto';
import fs from 'node:fs';
import { cardDigest, writeSpoolFile, removeSpoolEntry, spoolDir, readSpoolJson, answerIsHers } from './approvals.mts';
import type { ApprovalRequest } from './approval-prompt-core.mts';
import { rejectionOption } from './acp.mts';
import type { PermissionOption } from './acp.mts';
import type { CursorAskParams } from './cursor.mts';

const REQUEST_SUFFIX = '.request.json';

export interface CursorAskAnswer {
  questionId: string;
  selectedOptionIds: string[];
}

interface OpenEntry {
  kind: 'permission' | 'ask' | 'plan';
  requestId?: unknown;
  options?: PermissionOption[];
  decide?: (value: unknown) => void;
  reject?: (error: Error) => void;
}

export interface CursorSpoolScope {
  product: string;
  item: string;
  say?: (line: string) => void;
}

export function createCursorSpool({ storeRoot, uuid = crypto.randomUUID, onChange = null }: {
  storeRoot: string;
  uuid?: () => string;
  onChange?: (() => void) | null;
}) {
  const dir = spoolDir(storeRoot);
  fs.mkdirSync(dir, { recursive: true });
  const open = new Map<string, OpenEntry>();

  const writeRequest = (request: ApprovalRequest) => {
    if (!writeSpoolFile(dir, `${request.id}${REQUEST_SUFFIX}`, `${JSON.stringify(request)}\n`)) {
      throw Error('Could not write a Cursor question to the approvals spool');
    }
    onChange?.();
  };

  const scope = (ctx: CursorSpoolScope) => ({
    async permission(request: { requestId: unknown; options?: PermissionOption[]; toolCall?: { title?: string } }) {
      const id = String(request.requestId ?? uuid());
      const title = request.toolCall?.title ?? 'Run a tool';
      return new Promise<string | null>((resolve, reject) => {
        open.set(id, { kind: 'permission', requestId: request.requestId, options: request.options, decide: v => resolve(v as string | null), reject });
        writeRequest({
          id, at: Date.now(), product: ctx.product, item: ctx.item, tool: 'Execute',
          input: { command: title },
        });
      });
    },

    async ask(params: CursorAskParams) {
      const id = String(params.toolCallId ?? uuid());
      return new Promise<{ outcome: 'answered'; answers: CursorAskAnswer[] } | { outcome: 'cancelled' } | { outcome: 'skipped' }>((resolve, reject) => {
        open.set(id, { kind: 'ask', decide: v => resolve(v as { outcome: 'answered'; answers: CursorAskAnswer[] } | { outcome: 'cancelled' } | { outcome: 'skipped' }), reject });
        writeRequest({
          id, at: Date.now(), product: ctx.product, item: ctx.item, tool: 'cursor/ask_question',
          input: { title: params.title ?? null, questions: params.questions ?? [] },
        });
      });
    },

    planAccepted() {
      return { outcome: { outcome: 'accepted' as const } };
    },
  });

  const settle = (id: string, allow: boolean, note?: string | null) => {
    const entry = open.get(id);
    if (!entry) return false;
    open.delete(id);
    try { removeSpoolEntry(dir, `${id}${REQUEST_SUFFIX}`); removeSpoolEntry(dir, `${id}.answer.json`); } catch { /* gone */ }
    onChange?.();
    if (entry.kind === 'permission') {
      const chosen = allow
        ? entry.options?.find(o => o?.kind === 'allow_once')?.optionId ?? entry.options?.find(o => o?.kind === 'allow_always')?.optionId ?? null
        : rejectionOption(entry.options ?? []);
      entry.decide?.(chosen);
      return true;
    }
    if (entry.kind === 'ask') {
      if (!allow) {
        entry.decide?.({ outcome: 'cancelled' });
        return true;
      }
      let answers: CursorAskAnswer[] = [];
      try {
        const parsed = note ? JSON.parse(note) as { answers?: CursorAskAnswer[] } : null;
        if (Array.isArray(parsed?.answers)) answers = parsed!.answers!;
      } catch { /* empty */ }
      if (!answers.length) {
        entry.decide?.({ outcome: 'cancelled' });
        return true;
      }
      entry.decide?.({ outcome: 'answered', answers });
      return true;
    }
    return false;
  };

  const cardChanged = (id: string, shown: unknown) => {
    const request = readSpoolJson(dir, `${id}${REQUEST_SUFFIX}`) as ApprovalRequest | null;
  if (!request) return true;
  const digest = cardDigest(request);
    return typeof shown === 'string' && digest !== null && digest !== shown;
  };

  const close = (reason: string) => {
    for (const [id, entry] of [...open]) {
      open.delete(id);
      entry.reject?.(Error(reason));
      try { removeSpoolEntry(dir, `${id}${REQUEST_SUFFIX}`); } catch { /* gone */ }
    }
  };

  const answerFromSpool = (id: string) => {
    const file = readSpoolJson(dir, `${id}.answer.json`);
    return answerIsHers(id, file) ? file : null;
  };

  return { scope, settle, cardChanged, close, answerFromSpool };
}

export type CursorSpool = ReturnType<typeof createCursorSpool>;
