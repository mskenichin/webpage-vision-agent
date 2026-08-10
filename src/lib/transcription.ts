import { DefaultAzureCredential } from "@azure/identity";

interface TranscriptionResponse {
  text?: string;
}

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
  throw new Error("TRANSCRIPTION_NOT_CONFIGURED");
}

export async function transcribeAudio(audio: File): Promise<string> {
  const deployment = process.env.AZURE_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe";
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  if (!token) throw new Error("TRANSCRIPTION_UNAVAILABLE");

  const body = new FormData();
  body.append("file", audio, audio.name || "recording.webm");
  body.append("language", "ja");

  const response = await fetch(
    `${resourceEndpoint()}/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions?api-version=2025-04-01-preview`,
    { method: "POST", headers: { Authorization: `Bearer ${token.token}` }, body },
  );
  if (!response.ok) throw new Error(`TRANSCRIPTION_UNAVAILABLE:${response.status}`);

  const payload = await response.json() as TranscriptionResponse;
  return payload.text?.trim() ?? "";
}