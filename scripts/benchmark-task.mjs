import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const allScenarios = JSON.parse(await readFile(join(root, "scripts/task-scenarios.json"), "utf8"));
const scenarios = allScenarios.slice(0, Number(process.env.BENCHMARK_LIMIT ?? allScenarios.length));
const baseUrl = (process.env.BENCHMARK_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const measuredRuns = Number(process.env.BENCHMARK_RUNS ?? 3);
const warmupRuns = Number(process.env.BENCHMARK_WARMUPS ?? 1);
const maxContinuations = Number(process.env.BENCHMARK_MAX_CONTINUATIONS ?? 30);
const requestTimeoutMs = Number(process.env.BENCHMARK_REQUEST_TIMEOUT_MS ?? 130_000);
const approveAllowedActions = process.env.BENCHMARK_APPROVE_ALLOWED_ACTIONS === "1";
const outputPath = process.env.BENCHMARK_OUTPUT ?? join(root, "benchmark-results/task-live.json");

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function numericValues(rows, key) {
  return rows.map(row => row[key]).filter(value => Number.isFinite(value));
}

function parseDetail(log) {
  if (!log.detail) return null;
  try {
    return JSON.parse(log.detail);
  } catch {
    return null;
  }
}

function durationFromMessage(message) {
  const match = message.match(/:\s*(\d+)ms$/u);
  return match ? Number(match[1]) : 0;
}

function summarizeLogs(logs) {
  const goalPlannerMs = logs
    .filter(log => log.message.startsWith("Goal Planner:"))
    .reduce((sum, log) => sum + durationFromMessage(log.message), 0);
  const nextStepPlannerMs = logs
    .filter(log => log.message.startsWith("Next-Step Planner:"))
    .reduce((sum, log) => sum + durationFromMessage(log.message), 0);

  const verifierCalls = new Map();
  for (const log of logs.filter(item => item.message.startsWith("Verifier:"))) {
    const detail = parseDetail(log);
    if (typeof detail?.durationMs !== "number") continue;
    const key = `${detail.model ?? "unknown"}:${detail.observationRevision ?? log.id}:${detail.durationMs}`;
    verifierCalls.set(key, {
      model: detail.model ?? null,
      durationMs: detail.durationMs,
      observationRevision: detail.observationRevision ?? null,
    });
  }

  const computerUseByStep = new Map();
  let currentStep = "unassigned-0";
  let stepExecution = 0;
  for (const log of logs) {
    const stepMatch = log.message.match(/^サブタスク (\d+):/u);
    if (stepMatch) {
      stepExecution += 1;
      currentStep = `${stepMatch[1]}-${stepExecution}`;
    }
    if (!log.message.startsWith("Computer Use:")) continue;
    const detail = parseDetail(log);
    if (!detail || typeof detail.modelCalls !== "number") continue;
    computerUseByStep.set(currentStep, detail);
  }
  const computerUseCalls = [...computerUseByStep.values()];

  return {
    goalPlannerMs,
    nextStepPlannerMs,
    plannerMs: goalPlannerMs + nextStepPlannerMs,
    verifierMs: [...verifierCalls.values()].reduce((sum, call) => sum + call.durationMs, 0),
    verifierCalls: [...verifierCalls.values()],
    computerUseModelCalls: computerUseCalls.reduce((sum, call) => sum + call.modelCalls, 0),
    computerUseModelMs: computerUseCalls.reduce((sum, call) => sum + call.modelDurationMs, 0),
    screenshotMs: computerUseCalls.reduce((sum, call) => sum + call.screenshotDurationMs, 0),
    browserSteps: computerUseCalls.reduce((sum, call) => sum + call.steps, 0),
    observations: computerUseCalls.reduce((sum, call) => sum + call.observations, 0),
    replans: logs.filter(log => log.message.includes("再計画します")).length,
  };
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function resetScenario(scenario) {
  await request("/api/realtime/tool", { method: "DELETE" });
  await request("/api/browser", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "navigate", url: scenario.startUrl, actor: "user" }),
  });
  await request("/api/chat", { method: "DELETE" });
}

function scenarioResult(scenario, run, warmup, startedAt, state, collectedLogs, continuations, approvals, explicitError = null) {
  const elapsedMs = performance.now() - startedAt;
  const logs = [...collectedLogs.values()];
  const finalMessage = [...(state.messages ?? [])].reverse().find(message => message.role === "assistant")?.content ?? "";
  const systemError = [...(state.messages ?? [])].reverse().find(message => message.role === "system" && message.content.includes("停止しました"));
  const goalsVerified = logs.some(log => log.level === "success" && log.message === "Verifier: 全ゴール制約を確認しました");
  const error = explicitError ?? systemError?.content ?? null;

  const metrics = summarizeLogs(logs);
  const accountedMs = metrics.plannerMs + metrics.verifierMs + metrics.computerUseModelMs + metrics.screenshotMs;
  return {
    scenarioId: scenario.id,
    run,
    warmup,
    success: goalsVerified && !error,
    elapsedMs,
    continuations,
    approvals,
    currentUrl: state.currentUrl,
    finalMessage,
    error,
    ...metrics,
    accountedMs,
    unaccountedMs: Math.max(0, elapsedMs - accountedMs),
  };
}

function collectLogs(collectedLogs, state) {
  for (const log of state?.processLogs ?? []) collectedLogs.set(log.id, log);
}

async function runScenario(scenario, run, warmup) {
  await resetScenario(scenario);
  const startedAt = performance.now();
  let continuation = false;
  let continuations = 0;
  let approvals = 0;
  let state;
  const collectedLogs = new Map();

  try {
    while (true) {
      state = await request("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: scenario.prompt, mode: "task", continuation }),
      });
      collectLogs(collectedLogs, state);
      continuation = state.taskContinuation === true;

      while (state.approval) {
        if (!approveAllowedActions || scenario.allowApprovals !== true) {
          return scenarioResult(scenario, run, warmup, startedAt, state, collectedLogs, continuations, approvals, `APPROVAL_REQUIRED:${state.approval.operation}`);
        }
        const approved = await request("/api/approval", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: state.approval.id, decision: "approve" }),
        });
        approvals += 1;
        state = approved.state;
        collectLogs(collectedLogs, state);
        continuation = approved.taskContinuation === true;
      }

      if (!continuation) break;
      continuations += 1;
      if (continuations > maxContinuations) {
        return scenarioResult(scenario, run, warmup, startedAt, state, collectedLogs, continuations, approvals, "TASK_CONTINUATION_LIMIT");
      }
    }
  } catch (error) {
    state = await request("/api/session").catch(() => state);
    if (!state) throw error;
    collectLogs(collectedLogs, state);
    return scenarioResult(scenario, run, warmup, startedAt, state, collectedLogs, continuations, approvals, error instanceof Error ? error.message : String(error));
  }

  return scenarioResult(scenario, run, warmup, startedAt, state, collectedLogs, continuations, approvals);
}

function summarize(rows) {
  const measured = rows.filter(row => !row.warmup);
  const successful = measured.filter(row => row.success);
  const elapsed = numericValues(measured, "elapsedMs");
  return {
    measuredRuns: measured.length,
    successfulRuns: successful.length,
    successRate: measured.length === 0 ? null : successful.length / measured.length,
    elapsedP50Ms: percentile(elapsed, 0.5),
    elapsedP95Ms: percentile(elapsed, 0.95),
    elapsedMeanMs: mean(elapsed),
    plannerMeanMs: mean(numericValues(measured, "plannerMs")),
    verifierMeanMs: mean(numericValues(measured, "verifierMs")),
    computerUseModelMeanMs: mean(numericValues(measured, "computerUseModelMs")),
    screenshotMeanMs: mean(numericValues(measured, "screenshotMs")),
    accountedMeanMs: mean(numericValues(measured, "accountedMs")),
    unaccountedMeanMs: mean(numericValues(measured, "unaccountedMs")),
    computerUseModelCallsMean: mean(numericValues(measured, "computerUseModelCalls")),
    browserStepsMean: mean(numericValues(measured, "browserSteps")),
    replansMean: mean(numericValues(measured, "replans")),
  };
}

await request("/api/session", { method: "POST" });
const rows = [];
for (const scenario of scenarios) {
  for (let index = 0; index < warmupRuns + measuredRuns; index += 1) {
    const warmup = index < warmupRuns;
    const run = warmup ? index + 1 : index - warmupRuns + 1;
    console.log(`[${scenario.id}] ${warmup ? "warmup" : "run"} ${run}`);
    try {
      const row = await runScenario(scenario, run, warmup);
      rows.push(row);
      console.log(`  ${row.success ? "PASS" : "FAIL"} ${Math.round(row.elapsedMs)}ms ${row.currentUrl}`);
    } catch (error) {
      rows.push({ scenarioId: scenario.id, run, warmup, success: false, error: error instanceof Error ? error.message : String(error) });
      console.error(`  FAIL ${rows.at(-1).error}`);
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), complete: false, baseUrl, rows }, null, 2)}\n`);
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  complete: true,
  baseUrl,
  methodology: {
    warmupRuns,
    measuredRuns,
    scenarios: scenarios.length,
    successCriterion: "final response completed without a system error and the process log contains successful verification of all goal constraints",
    approvalPolicy: approveAllowedActions
      ? "approve only when the scenario also declares allowApprovals=true"
      : "fail the run and retain partial metrics",
  },
  summary: summarize(rows),
  rows,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result.summary, null, 2));
console.log(`Saved: ${outputPath}`);