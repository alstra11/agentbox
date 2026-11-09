// The agent is asked to end a turn that needs a person with one JSON line.
// A finish that has no such line becomes a review instead.

import type { NeedKind, SessionOption } from './session.ts';

export const NEEDS_YOU_MARK = 'NEEDS_YOU{"question"';

const INSTRUCTION = 'If you need a decision before you can finish, end your reply with one line and nothing after it: NEEDS_YOU{"question":"<one line>","options":[{"text":"<choice>","recommended":true},{"text":"<other>"}]}. The recommended option is the one you would take. Leave the line off when you can finish without a decision.';

export function withNeedsYou(prompt: string): string {
  const text = prompt.trim();
  if (text.includes(NEEDS_YOU_MARK)) return text;
  return `${text}\n\n${INSTRUCTION}`;
}

export interface ParsedNeed {
  question: string;
  options: SessionOption[];
  recommended: string | null;
  kind: NeedKind;
}

export function parseNeedsYou(result: string): ParsedNeed | null {
  if (!result) return null;
  let from = 0;
  let found: ParsedNeed | null = null;
  while (from < result.length) {
    const at = result.indexOf('NEEDS_YOU', from);
    if (at < 0) break;
    let i = at + 'NEEDS_YOU'.length;
    while (result[i] === ' ' || result[i] === '\n' || result[i] === '\t') i += 1;
    if (result[i] !== '{') {
      from = at + 'NEEDS_YOU'.length;
      continue;
    }
    const json = sliceObject(result, i);
    if (!json) {
      from = i + 1;
      continue;
    }
    const parsed = interpret(json);
    if (parsed) found = parsed;
    from = i + json.length;
  }
  return found;
}

function sliceObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function interpret(json: string): ParsedNeed | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return null;
  if (!Array.isArray(body.options) || body.options.length === 0) return null;
  const options: SessionOption[] = [];
  for (const entry of body.options.slice(0, 8)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (!text) continue;
    options.push({ n: options.length + 1, text: text.slice(0, 200), recommended: row.recommended === true });
  }
  if (!options.length) return null;
  if (typeof body.recommended === 'string' && body.recommended.trim()) {
    const want = body.recommended.trim();
    for (const opt of options) opt.recommended = opt.text === want;
  }
  const recommended = options.find((opt) => opt.recommended)?.text ?? null;
  const kind: NeedKind = body.kind === 'approval' || body.kind === 'review' || body.kind === 'question' ? body.kind : 'question';
  return { question: question.slice(0, 300), options, recommended, kind };
}
