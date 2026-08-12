import { DefaultAzureCredential } from "@azure/identity";
import type { Interest, PageContext, Profile } from "./domain";
import { realtimeInstructions } from "./realtime-instructions";

const REALTIME_MODEL = "gpt-realtime-2.1-mini";

function endpoints() {
  const projectEndpoint = process.env.AZURE_FOUNDRY_PROJECT_ENDPOINT;
  if (projectEndpoint) {
    const url = new URL(projectEndpoint);
    const base = `${url.protocol}//${url.hostname}`;
    return { api: base, realtime: base };
  }

  const configured = process.env.AZURE_FOUNDRY_ENDPOINT?.replace(/\/$/, "");
  if (!configured) throw new Error("REALTIME_NOT_CONFIGURED");
  return {
    api: configured.replace(".cognitiveservices.azure.com", ".services.ai.azure.com"),
    realtime: configured.replace(".cognitiveservices.azure.com", ".services.ai.azure.com"),
  };
}

async function accessToken() {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  if (!token) throw new Error("REALTIME_UNAVAILABLE");
  return token.token;
}

export async function createRealtimeSession(profile: Profile, currentUrl: string, interests: Interest[] = [], pageContext?: PageContext) {
  const model = process.env.AZURE_REALTIME_MODEL ?? REALTIME_MODEL;
  const { api, realtime } = endpoints();
  const response = await fetch(`${api}/openai/v1/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        instructions: realtimeInstructions(profile, currentUrl, interests, undefined, pageContext),
        output_modalities: ["audio"],
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            transcription: {
              model: process.env.AZURE_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe",
              language: "ja",
              prompt: "日本語のLexus車に関する会話です。Lexus、レクサス、IS、ES、LS、UX、NX、RX、RZ、GX、LX、LBX、LM、RC、LC、パッケージ、グレード、ハイブリッド、PHEV、BEVを正確に認識してください。",
            },
            turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: false, interrupt_response: true },
          },
          output: { voice: process.env.AZURE_REALTIME_VOICE ?? "alloy" },
        },
        tools: [
          {
            type: "function",
            name: "delegate_complex_query",
            description: "複数条件の比較、推薦、注意点の整理など、専門的で複雑な回答を生成する。",
            parameters: {
              type: "object",
              properties: { query: { type: "string", description: "ユーザーの要求を省略せず記載する" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
          {
            type: "function",
            name: "request_browser_task",
            description: "Lexus公式サイト内でページを探索・表示し、クリック、スクロール、色・グレード・オプションなど表示中UIの選択を変更する。ユーザーが画面操作を求めた場合に使用する。",
            parameters: {
              type: "object",
              properties: { goal: { type: "string", description: "達成する閲覧上の目的" } },
              required: ["goal"],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: "auto",
      },
    }),
  });
  if (!response.ok) throw new Error(`REALTIME_UNAVAILABLE:${response.status}`);
  const payload = await response.json() as { value?: string; expires_at?: number };
  if (!payload.value) throw new Error("REALTIME_UNAVAILABLE:EMPTY_SECRET");
  return {
    clientSecret: payload.value,
    expiresAt: payload.expires_at,
    model,
    callsUrl: `${realtime}/openai/v1/realtime/calls?model=${encodeURIComponent(model)}`,
  };
}