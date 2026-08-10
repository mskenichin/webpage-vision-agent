import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const allScenarios = JSON.parse(await readFile(join(root, "scripts/delegation-scenarios.json"), "utf8"));
const scenarios = allScenarios.slice(0, Number(process.env.BENCHMARK_LIMIT ?? allScenarios.length));
const models = (process.env.BENCHMARK_MODELS ?? "gpt-5.4,gpt-5.6-sol").split(",");
const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT ?? "https://aif-webpage-vision-agent-dev-6a372b32.cognitiveservices.azure.com";
const realtimeEndpoint = process.env.AZURE_REALTIME_ENDPOINT ?? endpoint.replace(".cognitiveservices.azure.com", ".services.ai.azure.com");
const token = process.env.AZURE_ACCESS_TOKEN ?? execFileSync("az", ["account", "get-access-token", "--resource", "https://cognitiveservices.azure.com", "--query", "accessToken", "-o", "tsv"], { encoding: "utf8" }).trim();
const outputPath = process.env.BENCHMARK_OUTPUT ?? join(root, "benchmark-results/delegation-comparison.json");
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const browserTool = {
  type: "function",
  name: "request_browser_task",
  description: "Lexus公式サイト内のページ表示をサーバーオーケストレーターへ依頼する。ページ操作を明示された場合だけ呼び出す。",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string" },
      path: { type: "string", description: "許可された相対パス。例: /models/nx/" },
    },
    required: ["goal", "path"],
    additionalProperties: false,
  },
};

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function normalize(value) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s。、！？,.!?「」『』]/g, "");
}

function normalizePath(path) {
  if (typeof path !== "string") return null;
  const normalized = `/${path.replace(/^\/+|\/+$/g, "")}/`.replace(/\/+/g, "/");
  return normalized === "//" ? "/" : normalized;
}

function qualityScore(answer, criteria) {
  const normalized = normalize(answer);
  const details = criteria.map(criterion => ({
    label: criterion.label,
    matched: criterion.patterns.some(pattern => new RegExp(pattern, "iu").test(normalized)),
  }));
  return { score: details.filter(item => item.matched).length / details.length, details };
}

function toolSucceeded(actual, expected) {
  if (!expected) return actual === null;
  return actual?.name === "request_browser_task" && normalizePath(actual.arguments?.path) === expected.path;
}

async function checkedFetch(url, init, attempt = 1) {
  const response = await fetch(url, init);
  if (response.ok) return response;
  if ((response.status === 429 || response.status >= 500) && attempt < 4) {
    await new Promise(resolve => setTimeout(resolve, attempt * 750));
    return checkedFetch(url, init, attempt + 1);
  }
  throw new Error(`${response.status} ${await response.text()}`);
}

function outputText(payload) {
  return payload.output?.flatMap(item => item.content ?? []).find(content => content.type === "output_text")?.text?.trim() ?? "";
}

async function requestAnswer(model, scenario) {
  const response = await checkedFetch(`${endpoint}/openai/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      instructions: "Lexusの日本語コンシェルジュです。提供された確認済み情報だけを根拠に、結論と理由を3〜5文で明確に答えてください。ページ操作は実行せず、比較上の注意点を省略しないでください。",
      input: `ユーザー要求: ${scenario.prompt}\n確認済み情報: ${scenario.facts}`,
      store: false,
    }),
  });
  const payload = await response.json();
  const text = outputText(payload);
  if (!text) throw new Error(`${model} returned no output text`);
  return text;
}

async function requestTool(model, scenario) {
  const response = await checkedFetch(`${endpoint}/openai/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      instructions: "ページを開く、表示する、見せる、移動するという明示的依頼がある場合だけrequest_browser_taskを呼び出してください。説明・比較だけなら呼び出さないでください。相対pathは必ずLexusの正規モデルURLにしてください。",
      input: scenario.prompt,
      tools: [browserTool],
      tool_choice: "auto",
      store: false,
    }),
  });
  const payload = await response.json();
  const call = payload.output?.find(item => item.type === "function_call");
  return call ? { name: call.name, arguments: JSON.parse(call.arguments) } : null;
}

async function realtimeSession(attempt = 1) {
  try {
    return await new Promise((resolve, reject) => {
      const url = `${realtimeEndpoint.replace("https://", "wss://")}/openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime-2.1-mini`;
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error("Realtime connection timeout")); }, 30000);
      ws.on("open", () => ws.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: "サーバーから返された専門回答を、内容を変えず自然な日本語音声で伝えてください。",
          modalities: ["audio", "text"],
          output_audio_format: "pcm16",
          voice: "alloy",
          turn_detection: null,
        },
      })));
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
    return realtimeSession(attempt + 1);
  }
}

async function delegatedFirstAudio(model, scenario) {
  const ws = await realtimeSession();
  const started = performance.now();
  const answer = await requestAnswer(model, scenario);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Delegated audio timeout")); }, 60000);
    ws.on("message", raw => {
      const event = JSON.parse(raw);
      if (event.type === "response.audio.delta") {
        clearTimeout(timer);
        const elapsed = performance.now() - started;
        ws.close();
        resolve({ firstAudioMs: elapsed, answer });
      }
      if (event.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(event.error?.message ?? "Realtime error")); }
    });
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: `専門モデルからの回答です。内容を変えず読み上げてください。\n${answer}` }] },
    }));
    ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"], voice: "alloy" } }));
  });
}

const rows = [];
for (const [index, scenario] of scenarios.entries()) {
  console.log(`[${index + 1}/${scenarios.length}] ${scenario.id}`);
  const row = { id: scenario.id, prompt: scenario.prompt, expectedTool: scenario.tool ?? null, models: {} };
  for (const model of models) {
    const delegated = await delegatedFirstAudio(model, scenario);
    const quality = qualityScore(delegated.answer, scenario.criteria);
    const tool = await requestTool(model, scenario);
    row.models[model] = {
      answer: delegated.answer,
      qualityScore: quality.score,
      qualityDetails: quality.details,
      tool,
      toolSuccess: toolSucceeded(tool, scenario.tool),
      delegatedFirstAudioMs: delegated.firstAudioMs,
    };
  }
  rows.push(row);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), complete: false, rows }, null, 2)}\n`);
}

const summary = Object.fromEntries(models.map(model => {
  const modelRows = rows.map(row => row.models[model]);
  const latencies = modelRows.map(row => row.delegatedFirstAudioMs);
  return [model, {
    meanQualityScore: modelRows.reduce((sum, row) => sum + row.qualityScore, 0) / modelRows.length,
    perfectQualityRate: modelRows.filter(row => row.qualityScore === 1).length / modelRows.length,
    toolCallSuccessRate: modelRows.filter(row => row.toolSuccess).length / modelRows.length,
    delegatedFirstAudioP50Ms: percentile(latencies, 0.5),
    delegatedFirstAudioP95Ms: percentile(latencies, 0.95),
    delegatedFirstAudioMeanMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
  }];
}));

const result = {
  generatedAt: new Date().toISOString(),
  complete: true,
  methodology: {
    scenarios: rows.length,
    expectedToolCalls: rows.filter(row => row.expectedTool).length,
    expectedToolAbstentions: rows.filter(row => !row.expectedTool).length,
    qualityMetric: "deterministic rubric coverage using only supplied verified facts",
    toolMetric: "correct function and normalized path, or correct abstention",
    latencyMetric: "expert model invocation through first gpt-realtime-2.1-mini audio delta; Realtime connection setup excluded",
  },
  summary,
  rows,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`Saved: ${outputPath}`);