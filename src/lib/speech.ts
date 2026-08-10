import { DefaultAzureCredential } from "@azure/identity";

function resourceEndpoint(): string {
  const projectEndpoint = process.env.AZURE_FOUNDRY_PROJECT_ENDPOINT;
  if (projectEndpoint) {
    const url = new URL(projectEndpoint);
    url.hostname = url.hostname.replace(".services.ai.azure.com", ".cognitiveservices.azure.com");
    url.pathname = "";
    return url.toString().replace(/\/$/, "");
  }

  const configured = process.env.AZURE_FOUNDRY_ENDPOINT?.replace(/\/$/, "");
  if (configured) return configured;
  throw new Error("SPEECH_NOT_CONFIGURED");
}

export async function synthesizeSpeech(text: string): Promise<Response> {
  const deployment = process.env.AZURE_SPEECH_MODEL ?? "gpt-4o-mini-tts";
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  if (!token) throw new Error("SPEECH_UNAVAILABLE");

  const response = await fetch(
    `${resourceEndpoint()}/openai/deployments/${encodeURIComponent(deployment)}/audio/speech?api-version=2025-04-01-preview`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: deployment,
        voice: process.env.AZURE_SPEECH_VOICE ?? "alloy",
        input: text,
        response_format: "mp3",
        instructions: "自然で落ち着いた日本語のLexusコンシェルジュとして、滑らかで聞き取りやすく話してください。",
      }),
    },
  );
  if (!response.ok || !response.body) throw new Error(`SPEECH_UNAVAILABLE:${response.status}`);
  return response;
}