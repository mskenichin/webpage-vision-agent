export type Actor = "user" | "agent";

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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface AppState {
  sessionId: string;
  browserStatus: BrowserStatus;
  currentUrl: string;
  profile: Profile;
  interests: Interest[];
  activity: ActivityEvent[];
  messages: ChatMessage[];
  agentMode: "foundry" | "demo";
}

export interface BrowserAction {
  type: "click" | "scroll" | "type" | "key" | "back" | "reload" | "navigate";
  x?: number;
  y?: number;
  deltaY?: number;
  text?: string;
  key?: string;
  url?: string;
  actor: Actor;
}