import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const allScenarios = JSON.parse(await readFile(join(root, "scripts/voice-scenarios.json"), "utf8"));
const scenarios = allScenarios.slice(0, Number(process.env.BENCHMARK_LIMIT ?? allScenarios.length));
const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT ?? "https://aif-webpage-vision-agent-dev-6a372b32.cognitiveservices.azure.com";
const realtimeEndpoint = process.env.AZURE_REALTIME_ENDPOINT ?? endpoint.replace(".cognitiveservices.azure.com", ".services.ai.azure.com");
const token = process.env.AZURE_ACCESS_TOKEN ?? execFileSync("az", ["account", "get-access-token", "--resource", "https://cognitiveservices.azure.com", "--query", "accessToken", "-o", "tsv"], { encoding: "utf8" }).trim();
const outputPath = process.env.BENCHMARK_OUTPUT ?? join(root, "benchmark-results/voice-comparison.json");
const cacheDir = join(root, "benchmark-results/audio");

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const tool = {
  type: "function",
  name: "navigate_lexus",
  description: "Lexus公式サイト内の指定されたモデルまたはモデル一覧ページへ移動する。情報の説明だけなら呼び出さない。",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "例: /models/nx/" } },
    required: ["path"],
    additionalProperties: false,
  },
};

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function normalizeJapanese(value) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s。、！？,.!?「」『』ー]/g, "");
}

function distance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function characterErrorRate(expected, actual) {
  const normalizedExpected = normalizeJapanese(expected);
  return distance(normalizedExpected, normalizeJapanese(actual)) / Math.max(normalizedExpected.length, 1);
}

function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function checkedFetch(url, init, attempt = 1) {
  const response = await fetch(url, init);
  if (response.ok) return response;
  if ((response.status === 429 || response.status >= 500) && attempt < 3) {
    await new Promise(resolve => setTimeout(resolve, attempt * 500));
    return checkedFetch(url, init, attempt + 1);
  }
  throw new Error(`${response.status} ${await response.text()}`);
}

async function inputAudio(scenario) {
  const path = join(cacheDir, `${scenario.id}.pcm`);
  try {
    return await readFile(path);
  } catch {
    const response = await checkedFetch(`${endpoint}/openai/deployments/gpt-4o-mini-tts/audio/speech?api-version=2025-04-01-preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: scenario.utterance, response_format: "pcm", instructions: "自然な日本語で一度だけ明瞭に発話してください。" }),
    });
    const pcm = Buffer.from(await response.arrayBuffer());
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path, pcm);
    return pcm;
  }
}

async function transcribeCurrent(pcm) {
  const body = new FormData();
  body.append("file", new Blob([pcmToWav(pcm)], { type: "audio/wav" }), "input.wav");
  body.append("language", "ja");
  const response = await checkedFetch(`${endpoint}/openai/deployments/gpt-4o-mini-transcribe/audio/transcriptions?api-version=2025-04-01-preview`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
  return (await response.json()).text?.trim() ?? "";
}

async function currentFirstAudio(transcript) {
  const started = performance.now();
  const chat = await checkedFetch(`${endpoint}/openai/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5.4", instructions: "Lexusの日本語コンシェルジュとして二文以内で簡潔に答えてください。", input: transcript, store: false }),
  });
  const payload = await chat.json();
  const text = payload.output?.flatMap(item => item.content ?? []).find(item => item.type === "output_text")?.text ?? "承知しました。";
  const speech = await checkedFetch(`${endpoint}/openai/deployments/gpt-4o-mini-tts/audio/speech?api-version=2025-04-01-preview`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "pcm" }),
  });
  const reader = speech.body.getReader();
  await reader.read();
  await reader.cancel();
  return performance.now() - started;
}

async function currentToolCall(utterance) {
  const response = await checkedFetch(`${endpoint}/openai/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5.4", instructions: "ページを開く、表示する、見せる、移動する、または車を探す依頼では必ず関数を呼び出してください。情報の説明や質問だけなら関数を呼び出さないでください。", input: utterance, tools: [tool], tool_choice: "auto", store: false }),
  });
  const payload = await response.json();
  const call = payload.output?.find(item => item.type === "function_call");
  return call ? { name: call.name, arguments: JSON.parse(call.arguments) } : null;
}

async function realtimeSession(options = {}, attempt = 1) {
  const { audio = true, tools = [] } = options;
  try {
    return await new Promise((resolve, reject) => {
    const url = `${realtimeEndpoint.replace("https://", "wss://")}/openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime-2.1-mini`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Realtime connection timeout")); }, 30000);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: audio
            ? "Lexusの日本語コンシェルジュです。ユーザーの発話を理解し、二文以内で自然に答えてください。"
            : "ページを開く、表示する、見せる、移動する、または車を探す依頼では必ず関数を呼び出してください。情報の説明や質問だけなら関数を呼び出さないでください。",
          modalities: audio ? ["audio", "text"] : ["text"],
          tools,
          tool_choice: "auto",
          input_audio_format: audio ? "pcm16" : undefined,
          output_audio_format: audio ? "pcm16" : undefined,
          voice: audio ? "alloy" : undefined,
          turn_detection: audio ? { type: "server_vad", silence_duration_ms: 500 } : undefined,
        },
      }));
    });
    ws.on("message", raw => {
      const event = JSON.parse(raw);
      if (event.type === "session.updated") { clearTimeout(timer); resolve(ws); }
      if (event.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(event.error?.message ?? "Realtime error")); }
    });
    ws.on("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => { clearTimeout(timer); reject(new Error(`Realtime handshake ${response.statusCode}: ${body}`)); });
      response.on("error", () => undefined);
      response.socket?.on("error", () => undefined);
    });
    ws.on("error", error => { clearTimeout(timer); reject(error); });
    });
  } catch (error) {
    if (attempt >= 5) throw error;
    await new Promise(resolve => setTimeout(resolve, attempt * 750));
    return realtimeSession(options, attempt + 1);
  }
}

async function realtimeVoice(pcm) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), complete: false, rows }, null, 2)}\n`);
  const ws = await realtimeSession();
  const audio = Buffer.concat([pcm, Buffer.alloc(48000)]);
  return new Promise((resolve, reject) => {
    let firstAudioMs;
    let outputTranscript = "";
    let inputEndedAt;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Realtime voice timeout")); }, 45000);
    ws.on("message", raw => {
      const event = JSON.parse(raw);
      if (event.type === "input_audio_buffer.speech_stopped") inputEndedAt = performance.now();
      if (event.type === "response.audio.delta" && firstAudioMs === undefined) firstAudioMs = performance.now() - (inputEndedAt ?? performance.now());
      if (event.type === "response.audio_transcript.delta") outputTranscript += event.delta ?? "";
      if (event.type === "response.done") {
        clearTimeout(timer);
        ws.close();
        resolve({ firstAudioMs, outputTranscript });
      }
      if (event.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(event.error?.message ?? "Realtime error")); }
    });
    for (let offset = 0; offset < audio.length; offset += 24000) ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: audio.subarray(offset, offset + 24000).toString("base64") }));
  });
}

async function realtimeRecognition(pcm) {
  const ws = await realtimeSession();
  const audio = Buffer.concat([pcm, Buffer.alloc(48000)]);
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      instructions: "ユーザーの発話を一字一句そのまま復唱してください。他の言葉は一切加えないでください。",
      modalities: ["audio", "text"],
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      voice: "alloy",
      turn_detection: { type: "server_vad", silence_duration_ms: 500 },
    },
  }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime recognition update timeout")), 10000);
    const listener = raw => {
      const event = JSON.parse(raw);
      if (event.type === "session.updated") { clearTimeout(timer); ws.off("message", listener); resolve(); }
      if (event.type === "error") { clearTimeout(timer); ws.off("message", listener); reject(new Error(event.error?.message ?? "Realtime error")); }
    };
    ws.on("message", listener);
  });
  return new Promise((resolve, reject) => {
    let transcript = "";
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Realtime recognition timeout")); }, 45000);
    ws.on("message", raw => {
      const event = JSON.parse(raw);
      if (event.type === "response.audio_transcript.delta") transcript += event.delta ?? "";
      if (event.type === "response.done") { clearTimeout(timer); ws.close(); resolve(transcript.trim()); }
      if (event.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(event.error?.message ?? "Realtime error")); }
    });
    for (let offset = 0; offset < audio.length; offset += 24000) ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: audio.subarray(offset, offset + 24000).toString("base64") }));
  });
}

async function realtimeToolCall(utterance) {
  const ws = await realtimeSession({ audio: false, tools: [tool] });
  return new Promise((resolve, reject) => {
    let call = null;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Realtime tool timeout")); }, 30000);
    ws.on("message", raw => {
      const event = JSON.parse(raw);
      if (event.type === "response.output_item.done" && event.item?.type === "function_call") call = { name: event.item.name, arguments: JSON.parse(event.item.arguments) };
      if (event.type === "response.done") { clearTimeout(timer); ws.close(); resolve(call); }
      if (event.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(event.error?.message ?? "Realtime error")); }
    });
    ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: utterance }] } }));
    ws.send(JSON.stringify({ type: "response.create" }));
  });
}

async function currentInterrupt() {
  const controller = new AbortController();
  const request = fetch(`${endpoint}/openai/deployments/gpt-4o-mini-tts/audio/speech?api-version=2025-04-01-preview`, { method: "POST", headers, signal: controller.signal, body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: "レクサスの車種について詳しくご案内します。まずSUVには複数の選択肢があります。", response_format: "pcm" }) }).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 100));
  const started = performance.now();
  controller.abort();
  await request;
  return performance.now() - started;
}

async function realtimeInterrupt() {
  const ws = await realtimeSession();
  return new Promise((resolve, reject) => {
    let cancelAt;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Realtime interrupt timeout")); }, 30000);
    ws.on("message", raw => {
      const event = JSON.parse(raw);
      if (event.type === "response.audio.delta" && cancelAt === undefined) { cancelAt = performance.now(); ws.send(JSON.stringify({ type: "response.cancel" })); }
      if (cancelAt !== undefined && event.type === "response.done") { clearTimeout(timer); ws.close(); resolve(performance.now() - cancelAt); }
      if (event.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(event.error?.message ?? "Realtime error")); }
    });
    ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "レクサスのSUVについて詳しく説明してください。" }] } }));
    ws.send(JSON.stringify({ type: "response.create" }));
  });
}

function toolSucceeded(actual, expected) {
  if (!expected) return actual === null;
  return actual?.name === "navigate_lexus" && actual.arguments?.path?.toLowerCase() === expected.path;
}

const rows = [];
for (const [index, scenario] of scenarios.entries()) {
  console.log(`[${index + 1}/${scenarios.length}] ${scenario.id}`);
  const pcm = await inputAudio(scenario);
  const currentStarted = performance.now();
  const currentTranscript = await transcribeCurrent(pcm);
  const currentFirstAudioMs = performance.now() - currentStarted + await currentFirstAudio(currentTranscript);
  const realtime = await realtimeVoice(pcm);
  const realtimeTranscript = await realtimeRecognition(pcm);
  const row = {
    id: scenario.id,
    utterance: scenario.utterance,
    current: { transcript: currentTranscript, cer: characterErrorRate(scenario.utterance, currentTranscript), firstAudioMs: currentFirstAudioMs },
    realtime: { transcript: realtimeTranscript, cer: characterErrorRate(scenario.utterance, realtimeTranscript), firstAudioMs: realtime.firstAudioMs, responseTranscript: realtime.outputTranscript },
  };
  row.expectedTool = scenario.tool ?? null;
  row.current.tool = await currentToolCall(scenario.utterance);
  row.realtime.tool = await realtimeToolCall(scenario.utterance);
  row.current.toolSuccess = toolSucceeded(row.current.tool, scenario.tool);
  row.realtime.toolSuccess = toolSucceeded(row.realtime.tool, scenario.tool);
  rows.push(row);
}

const currentInterruptMs = await currentInterrupt();
const realtimeInterruptMs = await realtimeInterrupt();
const summarize = key => ({
  firstAudioP50Ms: percentile(rows.map(row => row[key].firstAudioMs), 0.5),
  firstAudioP95Ms: percentile(rows.map(row => row[key].firstAudioMs), 0.95),
  meanCer: rows.reduce((sum, row) => sum + row[key].cer, 0) / rows.length,
  exactRecognitionRate: rows.filter(row => row[key].cer === 0).length / rows.length,
  toolCallSuccessRate: rows.filter(row => row[key].toolSuccess).length / rows.length,
  interruptMs: key === "current" ? currentInterruptMs : realtimeInterruptMs,
});
const result = { generatedAt: new Date().toISOString(), methodology: { scenarios: rows.length, expectedToolCalls: rows.filter(row => row.expectedTool).length, expectedToolAbstentions: rows.filter(row => !row.expectedTool).length, latencyOrigin: "audio upload complete for current pipeline; server detected speech stop for realtime", recognitionMetric: "normalized character error rate; realtime uses a separate exact-repeat session because input transcription is not exposed by the unified model", toolMetric: "correct function and exact path when navigation is expected; no function call when explanation only is expected", interruptionMetric: "API cancellation acknowledgement; browser audio-device stop latency excluded" }, summary: { current: summarize("current"), realtime: summarize("realtime") }, rows };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result.summary, null, 2));
console.log(`Saved: ${outputPath}`);