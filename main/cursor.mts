import type { PermissionOption } from './acp.mts';

export interface CursorSession {
  sessionId?: string | null;
  saying?: string;
  result?: string | null;
  resultIsError?: boolean;
  cursorChange?: string[];
  [key: string]: unknown;
}

interface SessionUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  sessionId?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
}

export function captureCursorUpdate(session: CursorSession, method: string, params: unknown) {
  if (method !== 'session/update') return;
  const update = (params as { update?: SessionUpdate; sessionId?: string })?.update
    ?? (params as SessionUpdate);
  const sid = (params as { sessionId?: string })?.sessionId;
  if (sid) session.sessionId = sid;
  const kind = update?.sessionUpdate;
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const text = update?.content?.text ?? '';
    if (kind === 'agent_message_chunk' && text) {
      session.saying = `${session.saying ?? ''}${text}`;
      session.result = session.saying;
      session.resultIsError = false;
    }
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const title = update?.title;
    if (title && typeof title === 'string' && /write|edit|patch/i.test(title)) {
      const files = session.cursorChange ?? [];
      const match = title.match(/[\w./-]+\.\w+/);
      if (match && !files.includes(match[0])) files.push(match[0]);
      session.cursorChange = files;
    }
  }
}

export function cursorStreamingText(session: CursorSession, method: string, params: unknown): boolean {
  if (method !== 'session/update') return false;
  const update = (params as { update?: SessionUpdate })?.update ?? params as SessionUpdate;
  if (update?.sessionUpdate !== 'agent_message_chunk') return false;
  const text = update?.content?.text ?? '';
  if (!text) return false;
  session.saying = `${session.saying ?? ''}${text}`;
  return true;
}

export function summarizeCursorUpdate(session: CursorSession, method: string, params: unknown) {
  captureCursorUpdate(session, method, params);
  return session.saying ?? '';
}

export function traceCursorUpdate(_session: CursorSession, method: string, params: unknown) {
  if (method !== 'session/update') return null;
  const update = (params as { update?: SessionUpdate })?.update ?? params as SessionUpdate;
  if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.text) {
    return { role: 'assistant', content: update.content.text };
  }
  return null;
}

export function cursorActivity(method: string, params: unknown): { tool: string } | null {
  if (method !== 'session/update') return null;
  const update = (params as { update?: SessionUpdate })?.update ?? params as SessionUpdate;
  if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
    const title = update?.title ?? 'tool';
    return { tool: String(title) };
  }
  return null;
}

export function cursorAskCardBody(params: CursorAskParams | null | undefined): string {
  const questions = Array.isArray(params?.questions) ? params!.questions! : [];
  const lines: string[] = [];
  if (params?.title) lines.push(String(params.title));
  for (const q of questions) {
    lines.push(q.prompt);
    for (const opt of q.options ?? []) lines.push(`  • ${opt.label} (${opt.id})`);
  }
  return lines.join('\n');
}

export interface CursorAskParams {
  toolCallId?: string;
  title?: string;
  questions?: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
}

export type CursorPermissionOption = PermissionOption;
