export type Actor = "user" | "agent";

export type ExecutionMode = "normal" | "task";

export type BrowserStatus =
  | "starting"
  | "ready"
  | "user_controlled"
  | "agent_running"
  | "awaiting_approval"
  | "recovering"
  | "failed";

export interface Profile {
  displayName: string;
  region: string;
  language: "ja-JP";
  budget: string;
  usage: string;
  bodyType: string;
  passengers: number;
  priorities: string;
  activityCollection: boolean;
}

export interface ActivityEvent {
  id: string;
  sessionId: string;
  operationId: string;
  type: "page_viewed" | "link_clicked";
  actor: Actor;
  occurredAt: string;
  title: string;
  url: string;
  sourceUrl?: string;
  durationMs?: number;
}

export interface Interest {
  id: string;
  key: string;
  name: string;
  category: "model" | "body" | "feature" | "price" | "usage" | "design";
  score: number;
  evidenceIds: string[];
  updatedAt: string;
}

export interface PageContext {
  url: string;
  title: string;
  text: string;
  scope?: "page" | "viewport";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface ProcessLog {
  id: string;
  source: "agent" | "browser" | "realtime" | "system";
  level: "info" | "success" | "error";
  message: string;
  detail?: string;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  operation: string;
  targetUrl: string;
  impact: string;
  expiresAt: string;
}

export interface AppState {
  sessionId: string;
  browserStatus: BrowserStatus;
  currentUrl: string;
  profile: Profile;
  interests: Interest[];
  activity: ActivityEvent[];
  messages: ChatMessage[];
  processLogs: ProcessLog[];
  approval: ApprovalRequest | null;
  agentMode: "foundry" | "demo";
}

export interface BrowserAction {
  type: "click" | "double_click" | "scroll" | "type" | "key" | "wait" | "back" | "reload" | "navigate";
  x?: number;
  y?: number;
  deltaY?: number;
  text?: string;
  key?: string;
  url?: string;
  actor: Actor;
}