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
  runHistoryCollection: boolean;
}

export type RecordedActionType = Exclude<BrowserAction["type"], "type">;

export interface ElementFingerprint {
  tag: string;
  label?: string;
  href?: string;
}

export interface ElementLocator {
  tag: string;
  role?: string;
  name?: string;
  testId?: string;
  elementId?: string;
  fieldName?: string;
  href?: string;
  text?: string;
  nth?: number;
  inDialog?: boolean;
}

export interface RecordedBrowserAction {
  id: string;
  sequence: number;
  type: RecordedActionType;
  x?: number;
  y?: number;
  deltaY?: number;
  key?: string;
  url?: string;
  beforeUrl: string;
  afterUrl: string;
  beforeFrameRevision: number;
  afterFrameRevision: number;
  target?: ElementFingerprint;
  locator?: ElementLocator;
  startedAt: string;
  completedAt: string;
}

export type AgentRunHistoryStatus = "running" | "completed" | "failed" | "stopped";

export interface AgentRunHistory {
  id: string;
  prompt: string;
  executionMode: ExecutionMode;
  startedAt: string;
  completedAt?: string;
  startUrl: string;
  endUrl?: string;
  status: AgentRunHistoryStatus;
  reason?: string;
  containsTextInput: boolean;
  replayable: boolean;
  fallbackFromRunId?: string;
  schemaVersion?: number;
  actions: RecordedBrowserAction[];
}

export interface AgentRunHistorySummary extends Omit<AgentRunHistory, "actions"> {
  actionCount: number;
}

export type ReplayStatus = "idle" | "running" | "falling_back" | "completed" | "failed" | "stopped";

export interface ReplayProgress {
  runId: string;
  status: ReplayStatus;
  currentStep: number;
  totalSteps: number;
  currentAction?: RecordedActionType;
  message?: string;
}

export interface ReplayResult {
  ok: boolean;
  status: Exclude<ReplayStatus, "idle" | "running">;
  completedSteps: number;
  reason?: string;
  fallbackRunId?: string;
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
  replay: ReplayProgress | null;
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