import type { ActivityEvent, AppState, ApprovalRequest, BrowserAction, BrowserStatus, ChatMessage, Profile } from "./domain";
import { mergeInterests } from "./interests";

const initialProfile: Profile = {
  displayName: "デモユーザー",
  region: "東京都",
  language: "ja-JP",
  budget: "700万円前後",
  usage: "家族での週末利用",
  bodyType: "",
  passengers: 5,
  priorities: "安全性、荷室、快適性",
  activityCollection: true,
};

function createState(): AppState {
  return {
    sessionId: crypto.randomUUID(),
    browserStatus: "starting",
    currentUrl: "https://lexus.jp/",
    profile: initialProfile,
    interests: [],
    activity: [],
    messages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "ご希望を教えてください。Lexus公式サイトを一緒に見ながらご案内します。",
        createdAt: new Date().toISOString(),
      },
    ],
    approval: null,
    agentMode: process.env.AZURE_FOUNDRY_ENDPOINT && (process.env.AZURE_CHAT_MODEL || process.env.AZURE_FOUNDRY_MODEL) ? "foundry" : "demo",
  };
}

export interface PendingApproval {
  request: ApprovalRequest;
  goal: string;
  action: BrowserAction;
  responseId: string;
  callId: string;
  safetyChecks: Array<{ id: string; code: string; message: string }>;
  steps: number;
  observations: number;
}

export class DemoStore {
  private state = createState();
  private eventKeys = new Set<string>();
  private pendingApproval: PendingApproval | null = null;

  snapshot(): AppState {
    return structuredClone(this.state);
  }

  setBrowser(status: BrowserStatus, currentUrl?: string) {
    this.state.browserStatus = status;
    if (currentUrl) this.state.currentUrl = currentUrl;
  }

  setApproval(pending: PendingApproval) {
    this.pendingApproval = pending;
    this.state.approval = pending.request;
    this.state.browserStatus = "awaiting_approval";
  }

  takeApproval(id: string) {
    if (!this.pendingApproval || this.pendingApproval.request.id !== id) return null;
    if (Date.parse(this.pendingApproval.request.expiresAt) <= Date.now()) {
      this.clearApproval();
      return null;
    }
    const pending = this.pendingApproval;
    this.pendingApproval = null;
    this.state.approval = null;
    return pending;
  }

  clearApproval(id?: string) {
    if (id && this.pendingApproval?.request.id !== id) return false;
    this.pendingApproval = null;
    this.state.approval = null;
    if (this.state.browserStatus === "awaiting_approval") this.state.browserStatus = "ready";
    return true;
  }

  addMessage(role: ChatMessage["role"], content: string) {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    this.state.messages.push(message);
    return message;
  }

  addActivity(event: Omit<ActivityEvent, "id" | "occurredAt">) {
    if (!this.state.profile.activityCollection) return null;
    const eventKey = `${event.sessionId}:${event.operationId}:${event.type}`;
    if (this.eventKeys.has(eventKey)) return null;

    const stored: ActivityEvent = {
      ...event,
      id: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    };
    this.eventKeys.add(eventKey);
    this.state.activity.unshift(stored);
    this.state.activity = this.state.activity.slice(0, 100);
    this.state.interests = mergeInterests(this.state.interests, stored);
    return stored;
  }

  updateProfile(update: Partial<Profile>) {
    this.state.profile = { ...this.state.profile, ...update, language: "ja-JP" };
  }

  updateInterest(id: string, name: string) {
    const interest = this.state.interests.find((item) => item.id === id);
    if (interest) interest.name = name.trim() || interest.name;
  }

  deleteInterest(id: string) {
    this.state.interests = this.state.interests.filter((interest) => interest.id !== id);
  }

  clearActivity() {
    this.state.activity = [];
    this.state.interests = [];
    this.eventKeys.clear();
  }
}

declare global {
  var webpageVisionStore: DemoStore | undefined;
}

const compatibleStore = globalThis.webpageVisionStore;
export const store = compatibleStore && typeof compatibleStore.clearApproval === "function"
  ? compatibleStore
  : new DemoStore();
if (process.env.NODE_ENV !== "production") globalThis.webpageVisionStore = store;