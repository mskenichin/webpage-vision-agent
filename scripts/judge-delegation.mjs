import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const comparison = JSON.parse(await readFile(join(root, "benchmark-results/delegation-comparison.json"), "utf8"));
const scenarios = JSON.parse(await readFile(join(root, "scripts/delegation-scenarios.json"), "utf8"));
const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT ?? "https://aif-webpage-vision-agent-dev-6a372b32.cognitiveservices.azure.com";
const token = process.env.AZURE_ACCESS_TOKEN ?? execFileSync("az", ["account", "get-access-token", "--resource", "https://cognitiveservices.azure.com", "--query", "accessToken", "-o", "tsv"], { encoding: "utf8" }).trim();
const outputPath = process.env.BENCHMARK_OUTPUT ?? join(root, "benchmark-results/delegation-judge.json");

const schema = {
  type: "object",
  properties: {
    a: {
      type: "object",
      properties: {
        factuality: { type: "integer", minimum: 1, maximum: 5 },
        coverage: { type: "integer", minimum: 1, maximum: 5 },
        concision: { type: "integer", minimum: 1, maximum: 5 },
        instructionFollowing: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["factuality", "coverage", "concision", "instructionFollowing"],
      additionalProperties: false,
    },
    b: {
      type: "object",
      properties: {
        factuality: { type: "integer", minimum: 1, maximum: 5 },
        coverage: { type: "integer", minimum: 1, maximum: 5 },
        concision: { type: "integer", minimum: 1, maximum: 5 },
        instructionFollowing: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["factuality", "coverage", "concision", "instructionFollowing"],
      additionalProperties: false,
    },
    winner: { type: "string", enum: ["A", "B", "tie"] },
    reason: { type: "string" },
  },
  required: ["a", "b", "winner", "reason"],
  additionalProperties: false,
};

async function evaluate(body, attempt = 1) {
  const response = await fetch(`${endpoint}/openai/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return response.json();
  if ((response.status === 429 || response.status >= 500) && attempt < 4) {
    await new Promise(resolve => setTimeout(resolve, attempt * 750));
    return evaluate(body, attempt + 1);
  }
  throw new Error(`${response.status} ${await response.text()}`);
}

function total(scores) {
  return scores.factuality + scores.coverage + scores.concision + scores.instructionFollowing;
}

const rows = [];
for (const [index, row] of comparison.rows.entries()) {
  const scenario = scenarios.find(item => item.id === row.id);
  const reversed = index % 2 === 1;
  const aModel = reversed ? "gpt-5.6-sol" : "gpt-5.4";
  const bModel = reversed ? "gpt-5.4" : "gpt-5.6-sol";
  console.log(`[${index + 1}/${comparison.rows.length}] ${row.id}`);
  const payload = await evaluate({
    model: "gpt-5.5",
    instructions: "あなたは独立した厳格な評価者です。確認済み情報だけを正解根拠として回答AとBの説明部分を評価してください。ページ移動は別のtoolで実行・採点されるため、回答本文がページ移動を実行または宣言していなくても減点しないでください。正確性、重要事項の網羅、簡潔さ、3〜5文で答える指示への準拠を各1〜5点で採点してください。モデル名を推測せず、文章だけを評価してください。",
    input: `ユーザー要求: ${scenario.prompt}\n確認済み情報: ${scenario.facts}\n回答A: ${row.models[aModel].answer}\n回答B: ${row.models[bModel].answer}`,
    text: { format: { type: "json_schema", name: "delegation_evaluation", strict: true, schema } },
    store: false,
  });
  const text = payload.output?.flatMap(item => item.content ?? []).find(content => content.type === "output_text")?.text;
  if (!text) throw new Error(`Judge returned no output for ${row.id}`);
  const evaluation = JSON.parse(text);
  const mapped = {
    "gpt-5.4": aModel === "gpt-5.4" ? evaluation.a : evaluation.b,
    "gpt-5.6-sol": aModel === "gpt-5.6-sol" ? evaluation.a : evaluation.b,
  };
  const winner = evaluation.winner === "tie" ? "tie" : evaluation.winner === "A" ? aModel : bModel;
  rows.push({ id: row.id, placement: { A: aModel, B: bModel }, scores: mapped, winner, reason: evaluation.reason });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ complete: false, rows }, null, 2)}\n`);
}

const models = ["gpt-5.4", "gpt-5.6-sol"];
const summary = Object.fromEntries(models.map(model => {
  const scores = rows.map(row => row.scores[model]);
  return [model, {
    meanTotal: scores.reduce((sum, score) => sum + total(score), 0) / scores.length,
    meanFactuality: scores.reduce((sum, score) => sum + score.factuality, 0) / scores.length,
    meanCoverage: scores.reduce((sum, score) => sum + score.coverage, 0) / scores.length,
    meanConcision: scores.reduce((sum, score) => sum + score.concision, 0) / scores.length,
    meanInstructionFollowing: scores.reduce((sum, score) => sum + score.instructionFollowing, 0) / scores.length,
    wins: rows.filter(row => row.winner === model).length,
  }];
}));
summary.ties = rows.filter(row => row.winner === "tie").length;
const result = { generatedAt: new Date().toISOString(), complete: true, judgeModel: "gpt-5.5", methodology: { blindPlacement: "alternating A/B", scoreRange: "four dimensions, 1-5 each", limitation: "model-based subjective secondary evaluation; deterministic rubric remains primary" }, summary, rows };
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`Saved: ${outputPath}`);