// A cloud or local agent the relay is steering. The Mac's own threads stay in `threads`.

export const CLOUD_POLL_MS = 30_000;

export type SessionTarget = 'cloud' | 'local';

export type NeedKind = 'question' | 'approval' | 'review' | 'error';

export interface SessionOption {
  n: number;
  text: string;
  recommended: boolean;
}

export interface AgentSession {
  id: string;
  commandId: string;
  project: string;
  provider: string;
  target: SessionTarget;
  externalAgentId: string | null;
  externalRunId: string | null;
  runActive: boolean;
  followUpQueued: boolean;
  pendingPrompt: string | null;
  status: string;
  branch: string | null;
  prUrl: string | null;
  createdByDevice: string;
  title: string;
  prompt: string;
  repoUrl: string | null;
  startingRef: string | null;
  model: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionNeed {
  id: string;
  sessionId: string;
  project: string;
  runId: string | null;
  kind: NeedKind;
  question: string;
  options: SessionOption[];
  recommended: string | null;
  answer: string | null;
  createdAt: string;
  updatedAt: string;
}
