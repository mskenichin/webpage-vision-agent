import { DefaultAzureCredential } from "@azure/identity";
import type { ChatMessage, Interest, PageContext, Profile } from "./domain";
import { pageContextInstructions } from "./page-context";
import { profileInstructions } from "./profile-context";

interface OutputItem {
  content?: Array<{ type?: string; text?: string }>;
}

async function requestModel(
  model: string,
  query: string,
  profile: Profile,
  messages: ChatMessage[],
  currentUrl: string,
  interests: Interest[],
  pageContext: PageContext | undefined,
  signal: AbortSignal,
) {
  const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT?.replace(/\/$/, "");
  if (!endpoint) throw new Error("MODEL_UNAVAILABLE");
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  if (!token) throw new Error("MODEL_UNAVAILABLE");
  const history = messages.filter((message) => message.role !== "system").slice(-12)
    .map((message) => ({ role: message.role, content: message.content }));
  history.push({ role: "user", content: query });
  const response = await fetch(`${endpoint}/openai/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      instructions: `Lexusの日本語コンシェルジュとして、表示中ページの内容を確認した上で、正確かつ簡潔に3文以内で答えてください。\n${profileInstructions(profile, interests)}\n現在URL: ${currentUrl}\n${pageContextInstructions(pageContext)}`,
      input: history,
      store: false,
    }),
  });
  if (!response.ok) throw new Error(`MODEL_UNAVAILABLE:${response.status}`);
  const payload = await response.json() as { output?: OutputItem[] };
  const text = payload.output?.flatMap((item) => item.content ?? [])
    .find((content) => content.type === "output_text")?.text?.trim();
  if (!text) throw new Error("MODEL_UNAVAILABLE:EMPTY_RESPONSE");
  return text;
}

async function withTimeout<T>(milliseconds: number, task: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function delegateComplexQuery(
  query: string,
  profile: Profile,
  messages: ChatMessage[],
  currentUrl: string,
  interests: Interest[] = [],
  pageContext?: PageContext,
) {
  const primary = process.env.AZURE_EXPERT_MODEL ?? "gpt-5.6-sol";
  const fallback = process.env.AZURE_CHAT_MODEL ?? "gpt-5.4";
  try {
    return { text: await withTimeout(8_000, (signal) => requestModel(primary, query, profile, messages, currentUrl, interests, pageContext, signal)), model: primary };
  } catch {
    return { text: await withTimeout(12_000, (signal) => requestModel(fallback, query, profile, messages, currentUrl, interests, pageContext, signal)), model: fallback };
  }
}