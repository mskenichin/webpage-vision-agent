import { z } from "zod";
import { azureBearerToken } from "./azure-auth";
import { browserManager, type TaskBrowserObservation } from "./browser";
import { browserTaskRequest, runBrowserTask } from "./browser-task";
import type { ApprovalRequest } from "./domain";
import { runModelOperation } from "./model-operation";
import { store } from "./store";
import { failedConstraintResults, taskConstraintSchema, verifyTaskConstraints } from "./task-verifier";

const taskStepSchema = z.object({
  id: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(500),
  constraints: z.array(taskConstraintSchema).min(1).max(12),
}).superRefine((step, context) => {
  step.constraints.forEach((constraint, index) => {
    if (constraint.operator === "visible" && ["selection", "collection"].includes(constraint.target.kind)) {
      context.addIssue({
        code: "custom",
        path: ["constraints", index],
        message: "選択UIや一覧の一時的な表示ではなく、操作後も残る達成状態を制約にしてください。",
      });
    }
  });
});

export const taskPlanSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  goalConstraints: z.array(taskConstraintSchema).min(1).max(20),
}).superRefine((plan, context) => {
  plan.goalConstraints.forEach((constraint, index) => {
    if (constraint.operator === "visible" && ["selection", "collection"].includes(constraint.target.kind)) {
      context.addIssue({
        code: "custom",
        path: ["goalConstraints", index],
        message: "一時的な操作UIではなく、ユーザーが求める最終状態を制約にしてください。",
      });
    }
  });
});

export type TaskPlan = z.infer<typeof taskPlanSchema>;
export type TaskStep = z.infer<typeof taskStepSchema>;

export interface TaskModeResult {
  ok: boolean;
  steps: number;
  currentUrl: string;
  message?: string;
  awaitingApproval?: true;
  approval?: ApprovalRequest;
  continuationRequired?: true;
  conditionUnmet?: true;
  taskIncomplete?: true;
}

interface PlannerOutputItem {
  content?: Array<{ type?: string; text?: string }>;
}

interface ActiveTask {
  goal: string;
  plan: TaskPlan;
  currentStep: TaskStep | null;
  completedSteps: Array<{ instruction: string; constraintIds: string[] }>;
  goalEvidence: Array<{ id: string; passed: boolean; evidence: string }>;
  failedEvidence: string[];
  stepAttempts: number;
  plannedSteps: number;
  replans: number;
  latestObservation: TaskBrowserObservation | null;
}

let activeTask: ActiveTask | null = null;
const MAX_PLANNED_STEPS = 12;
const MAX_REPLANS = 4;

export function combineTaskConstraints(stepConstraints: TaskStep["constraints"], goalConstraints: TaskPlan["goalConstraints"]) {
  const combined = new Map<string, TaskStep["constraints"][number]>();
  for (const constraint of [...stepConstraints, ...goalConstraints]) {
    const existing = combined.get(constraint.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(constraint)) {
      throw new Error(`TASK_CONSTRAINT_ID_COLLISION:${constraint.id}`);
    }
    combined.set(constraint.id, constraint);
  }
  return [...combined.values()];
}

export function normalizeStepConstraintIds(step: TaskStep, goalConstraints: TaskPlan["goalConstraints"]) {
  const usedIds = new Set(goalConstraints.map((constraint) => constraint.id));
  return {
    ...step,
    constraints: step.constraints.map((constraint, index) => {
      let id = constraint.id;
      let suffix = 1;
      while (usedIds.has(id)) {
        const prefix = `step-${index + 1}-${suffix}-`;
        id = `${prefix}${constraint.id}`.slice(0, 80);
        suffix += 1;
      }
      usedIds.add(id);
      return id === constraint.id ? constraint : { ...constraint, id };
    }),
  };
}

export function parseTaskPlan(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const plan = taskPlanSchema.parse(JSON.parse((fenced ?? text).trim()));
  const requiresSelectionScope = plan.goalConstraints.some((constraint) => constraint.operator === "all_available_selected");
  const hasSelectionScope = plan.goalConstraints.some((constraint) =>
    constraint.target.kind === "collection"
    && constraint.operator === "count_equals"
    && constraint.expected === 0
    && /要求外|要求に含まれない|未指定|以外/.test(`${constraint.target.label} ${constraint.description}`),
  );
  if (!requiresSelectionScope || hasSelectionScope) return plan;
  const requestedCategories = plan.goalConstraints
    .filter((constraint) => constraint.operator === "all_available_selected")
    .map((constraint) => constraint.target.label)
    .join("、");
  return {
    ...plan,
    goalConstraints: [
      ...plan.goalConstraints,
      {
        id: "unrequested-optional-selections",
        target: { kind: "collection" as const, label: "ユーザー要求に含まれない追加オプション" },
        operator: "count_equals" as const,
        expected: 0,
        evidence: ["screenshot" as const, "page_text" as const],
        description: `ユーザーが明示的に要求した項目またはカテゴリ（${requestedCategories}）以外の任意追加オプションが0件であること。`,
      },
    ],
  };
}

export function taskExecutionGoal(goal: string, step: TaskStep, stepNumber: number, goalConstraints: TaskPlan["goalConstraints"] = []) {
  const persistentExclusions = goalConstraints.filter((constraint) =>
    constraint.operator === "not_selected"
    || constraint.operator === "not_visible"
    || (constraint.operator === "count_equals" && constraint.expected === 0),
  );
  return [
    `全体のユーザー要求: ${goal}`,
    `現在のサブタスク (${stepNumber}): ${step.instruction}`,
    `構造化制約: ${JSON.stringify(step.constraints)}`,
    ...(persistentExclusions.length > 0 ? [`常時維持する除外制約: ${JSON.stringify(persistentExclusions)}`] : []),
    "このサブタスクだけを実行してください。required相当の制約を満たし、not_selected、not_visible、count_equalsなどの除外制約に反する状態があれば解除または修正してください。各制約IDについて画面上で確認した証拠を終了報告に含めてください。",
  ].join("\n");
}

export function taskStepExecutionGoal(goal: string, step: TaskStep, stepNumber: number, currentUrl: string, goalConstraints: TaskPlan["goalConstraints"] = []) {
  const requiresPageInteraction = /見積|シミュレーション|選択|設定|変更|追加|すべて|全部|確認/i.test(step.instruction);
  return !requiresPageInteraction && browserTaskRequest(step.instruction, currentUrl)
    ? step.instruction
    : taskExecutionGoal(goal, step, stepNumber, goalConstraints);
}

async function requestPlanFromModel(model: string, goal: string, signal: AbortSignal) {
  const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT?.replace(/\/$/, "");
  if (!endpoint) throw new Error("MODEL_UNAVAILABLE");
  const token = await azureBearerToken();
  const state = store.snapshot();
  const response = await fetch(`${endpoint}/openai/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      instructions: `あなたはユーザー要求から、UI構造に依存しない最終ゴールを抽出するPlannerです。具体的な操作手順や未観測画面の構造は計画しないでください。
    ユーザー要求の包含、除外、数量、上限・下限、完全選択、最終表示状態を、それぞれ独立したgoalConstraintsへ変換してください。「Xだけ」「X以外は付けない」では包含制約と除外またはcount_equals制約の両方を生成してください。
    特定カテゴリの全項目を選ぶ要求では、そのカテゴリ以外の任意追加項目を選択してよいとは解釈しません。ユーザーが別途明示した項目を除き、要求に含まれない追加オプションが0件であるcount_equals制約も生成してください。
    一時的な操作UI、選択肢、一覧、タブが表示されることをゴールにしてはいけません。selectionとcollectionにvisibleを使わず、選択結果はequals、selected、contains、完全選択はall_available_selected、count_equalsで表現してください。
    外部送信、購入、予約、問い合わせ、個人情報入力は含めないでください。target.kindはpage、url、selection、value、collection、operatorはvisible、not_visible、selected、not_selected、equals、contains、all_available_selected、count_equals、greater_than_or_equal、less_than_or_equalから選びます。
    JSON以外を出力せず、次の形式に厳密に従ってください: {"summary":"...","goalConstraints":[{"id":"...","target":{"kind":"selection","label":"..."},"operator":"equals","expected":"...","evidence":["screenshot","page_text"],"description":"..."}]}`,
      input: [{
        role: "user",
        content: `ユーザー要求: ${goal}\n現在URL: ${state.currentUrl}`,
      }],
      store: false,
    }),
  });
  if (!response.ok) throw new Error(`MODEL_UNAVAILABLE:${response.status}`);
  const payload = await response.json() as { output?: PlannerOutputItem[] };
  const text = payload.output?.flatMap((item) => item.content ?? [])
    .find((content) => content.type === "output_text")?.text?.trim();
  if (!text) throw new Error("MODEL_UNAVAILABLE:EMPTY_TASK_PLAN");
  return parseTaskPlan(text);
}

export function parseNextTaskStep(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return taskStepSchema.parse(JSON.parse((fenced ?? text).trim()));
}

async function requestNextStepFromModel(model: string, task: ActiveTask, signal: AbortSignal) {
  const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT?.replace(/\/$/, "");
  if (!endpoint) throw new Error("MODEL_UNAVAILABLE");
  const token = await azureBearerToken();
  const cachedObservation = task.latestObservation?.revision === browserManager.currentRevision()
    ? task.latestObservation
    : null;
  const pageContext = cachedObservation?.pageContext ?? await browserManager.pageContext(task.goal, false);
  const response = await fetch(`${endpoint}/openai/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      instructions: `あなたはブラウザタスクのNext-Step Plannerです。未観測の後続UIを推測せず、現在画面から実行可能な次の意味的サブタスクを1件だけ生成してください。
1サブタスクは「見積もり画面へ進む」「F SPORTを選択済みにする」のような1目的とし、複数カテゴリのUIを同時に表示させようとしてはいけません。クリック位置や具体的な操作列は書かず、Executorが達成すべき状態をinstructionにします。
constraintsには、そのサブタスク後も画面の選択済み要約や構成内容で確認できる事後条件だけを設定してください。selectionまたはcollectionのvisibleは禁止です。現在画面ですでに明示された達成状態を再操作せず、未達または証拠不足のゴールへ進むための最小の1手を選んでください。
ゴール制約に要求外の追加選択を0件とする除外制約がある場合、選択操作ではその制約を維持してください。現在選択中の要求外項目が見える場合は、新しい項目を追加する前に解除するサブタスクを優先してください。
過去の失敗がある場合は同じ到達不能な状態を繰り返さず、現在画面から別の進め方を選んでください。外部送信、購入、予約、問い合わせ、個人情報入力は計画しないでください。
JSON以外を出力せず、次の形式に厳密に従ってください: {"id":"step-id","instruction":"...","constraints":[{"id":"step-constraint-id","target":{"kind":"selection","label":"..."},"operator":"equals","expected":"...","evidence":["screenshot","page_text"],"description":"..."}]}`,
      input: [{
        role: "user",
        content: `全体要求: ${task.goal}\nゴール制約: ${JSON.stringify(task.plan.goalConstraints)}\n直近のゴール検証: ${JSON.stringify(task.goalEvidence)}\n完了済みサブタスク: ${JSON.stringify(task.completedSteps)}\n直近の失敗: ${JSON.stringify(task.failedEvidence.slice(-3))}\n現在URL: ${pageContext.url}\n現在画面:\n${pageContext.text.slice(0, 6000)}`,
      }],
      store: false,
    }),
  });
  if (!response.ok) throw new Error(`MODEL_UNAVAILABLE:${response.status}`);
  const payload = await response.json() as { output?: PlannerOutputItem[] };
  const text = payload.output?.flatMap((item) => item.content ?? [])
    .find((content) => content.type === "output_text")?.text?.trim();
  if (!text) throw new Error("MODEL_UNAVAILABLE:EMPTY_NEXT_STEP");
  return parseNextTaskStep(text);
}

export function goalPlannerConfig() {
  return {
    primary: process.env.AZURE_GOAL_PLANNER_MODEL ?? process.env.AZURE_CHAT_MODEL ?? "gpt-5.4",
    fallback: process.env.AZURE_GOAL_PLANNER_FALLBACK_MODEL
      ?? process.env.AZURE_TASK_PLANNER_MODEL
      ?? process.env.AZURE_EXPERT_MODEL
      ?? "gpt-5.6-sol",
    primaryTimeoutMs: 30_000,
    fallbackTimeoutMs: 45_000,
  };
}

export async function createTaskPlan(goal: string) {
  const config = goalPlannerConfig();
  return runModelOperation({
    operation: "Goal Planner",
    primary: { model: config.primary, timeoutMs: config.primaryTimeoutMs },
    fallback: { model: config.fallback, timeoutMs: config.fallbackTimeoutMs },
    request: (model, signal) => requestPlanFromModel(model, goal, signal),
  });
}

export function nextStepPlannerConfig() {
  return {
    primary: process.env.AZURE_NEXT_STEP_PLANNER_MODEL ?? process.env.AZURE_CHAT_MODEL ?? "gpt-5.4",
    fallback: process.env.AZURE_NEXT_STEP_PLANNER_FALLBACK_MODEL
      ?? process.env.AZURE_TASK_PLANNER_MODEL
      ?? process.env.AZURE_EXPERT_MODEL
      ?? "gpt-5.6-sol",
    primaryTimeoutMs: 30_000,
    fallbackTimeoutMs: 45_000,
  };
}

async function createNextTaskStep(task: ActiveTask) {
  const config = nextStepPlannerConfig();
  return runModelOperation({
    operation: "Next-Step Planner",
    primary: { model: config.primary, timeoutMs: config.primaryTimeoutMs },
    fallback: { model: config.fallback, timeoutMs: config.fallbackTimeoutMs },
    request: (model, signal) => requestNextStepFromModel(model, task, signal),
  });
}

function isAwaitingApproval(result: unknown): result is { awaitingApproval: true } {
  return typeof result === "object" && result !== null && "awaitingApproval" in result
    && (result as { awaitingApproval?: boolean }).awaitingApproval === true;
}

function requiresContinuation(result: unknown): result is { continuationRequired: true } {
  return typeof result === "object" && result !== null && "continuationRequired" in result
    && (result as { continuationRequired?: boolean }).continuationRequired === true;
}

function hasUnmetCondition(result: unknown): result is { conditionUnmet: true; message: string; steps: number; currentUrl: string } {
  return typeof result === "object" && result !== null && "conditionUnmet" in result
    && (result as { conditionUnmet?: boolean }).conditionUnmet === true;
}

function resultProgress(result: unknown) {
  if (typeof result !== "object" || result === null) return { steps: 0, currentUrl: store.snapshot().currentUrl };
  const record = result as Record<string, unknown>;
  return {
    steps: typeof record.steps === "number" ? record.steps : 0,
    currentUrl: typeof record.currentUrl === "string" ? record.currentUrl : store.snapshot().currentUrl,
  };
}

function taskIncomplete(result: unknown, message: string): TaskModeResult {
  const progress = resultProgress(result);
  activeTask = null;
  return { ok: false, ...progress, conditionUnmet: true, taskIncomplete: true, message: `タスクを完了できませんでした。${message}` };
}

function retryOrReplanStep(result: unknown, message: string): TaskModeResult {
  if (!activeTask) throw new Error("TASK_PLAN_UNAVAILABLE");
  activeTask.stepAttempts += 1;
  activeTask.failedEvidence.push(message);
  store.addProcessLog("agent", "error", `サブタスク ${activeTask.plannedSteps}の制約を確認できませんでした`, message);
  const progress = resultProgress(result);
  if (activeTask.stepAttempts < 2) {
    return { ok: false, ...progress, conditionUnmet: true, continuationRequired: true, message: "未達の制約を修正するため、同じサブタスクを再実行します。" };
  }
  activeTask.currentStep = null;
  activeTask.stepAttempts = 0;
  activeTask.replans += 1;
  if (activeTask.replans > MAX_REPLANS || activeTask.plannedSteps >= MAX_PLANNED_STEPS) {
    return taskIncomplete(result, message);
  }
  store.addProcessLog("agent", "info", "現在画面を再観測して次のサブタスクを再計画します", message);
  return { ok: false, ...progress, conditionUnmet: true, continuationRequired: true, message: "同じ方法では達成できなかったため、現在画面から次の1手を再計画します。" };
}

async function verifyAndAdvanceActiveStep(result: unknown): Promise<TaskModeResult> {
  if (!activeTask) throw new Error("TASK_PLAN_UNAVAILABLE");
  if (isAwaitingApproval(result) || requiresContinuation(result)) return result as TaskModeResult;
  if (hasUnmetCondition(result)) return retryOrReplanStep(result, result.message);
  const step = activeTask.currentStep;
  if (!step) throw new Error("TASK_STEP_UNAVAILABLE");
  const observation = await browserManager.taskObservation(
    [...step.constraints, ...activeTask.plan.goalConstraints].map((constraint) => constraint.description).join(" "),
  );
  activeTask.latestObservation = observation;
  const verification = await verifyTaskConstraints(
    combineTaskConstraints(step.constraints, activeTask.plan.goalConstraints),
    observation,
  );
  activeTask.goalEvidence = verification.results.filter((item) =>
    activeTask?.plan.goalConstraints.some((constraint) => constraint.id === item.id),
  );
  const failed = failedConstraintResults(step.constraints, verification);
  if (failed.length > 0) {
    const detail = JSON.stringify({ constraints: step.constraints, results: verification.results }, null, 2);
    store.addProcessLog("agent", "error", `Verifier: サブタスク ${activeTask.plannedSteps}に未達の制約があります`, detail);
    const failedDetail = failed.map(({ constraint, evidence }) => `${constraint.description}: ${evidence}`).join("\n");
    return retryOrReplanStep(result, failedDetail);
  }
  store.addProcessLog(
    "agent",
    "success",
    `Verifier: サブタスク ${activeTask.plannedSteps}の制約を確認しました`,
    JSON.stringify({ constraints: step.constraints, results: verification.results, model: verification.model, durationMs: verification.durationMs, observationRevision: verification.observationRevision }, null, 2),
  );
  activeTask.completedSteps.push({ instruction: step.instruction, constraintIds: step.constraints.map((constraint) => constraint.id) });
  activeTask.currentStep = null;
  activeTask.stepAttempts = 0;
  const progress = resultProgress(result);
  const unmetGoals = failedConstraintResults(activeTask.plan.goalConstraints, verification);
  store.addProcessLog(
    "agent",
    unmetGoals.length === 0 ? "success" : "info",
    unmetGoals.length === 0 ? "Verifier: 全ゴール制約を確認しました" : `Verifier: 未達または証拠不足のゴールが${unmetGoals.length}件あります`,
    JSON.stringify({ constraints: activeTask.plan.goalConstraints, results: activeTask.goalEvidence, model: verification.model, durationMs: verification.durationMs, observationRevision: verification.observationRevision }, null, 2),
  );
  if (unmetGoals.length > 0) {
    if (activeTask.plannedSteps >= MAX_PLANNED_STEPS) {
      const detail = unmetGoals.map(({ constraint, evidence }) => `${constraint.description}: ${evidence}`).join("\n");
      return taskIncomplete(result, detail);
    }
    return { ok: false, continuationRequired: true, ...progress, message: "現在のサブタスクを完了しました。最新画面から次の1手を計画します。" };
  }
  const message = `${activeTask.plan.summary} すべての構造化制約を画面上で確認しました。`;
  activeTask = null;
  return { ok: true, ...progress, message };
}

async function executeActiveTask(): Promise<TaskModeResult> {
  if (!activeTask) throw new Error("TASK_PLAN_UNAVAILABLE");
  if (!activeTask.currentStep) {
    if (activeTask.plannedSteps >= MAX_PLANNED_STEPS) {
      return taskIncomplete(null, "逐次計画の上限に達しました。");
    }
    activeTask.currentStep = normalizeStepConstraintIds(
      await createNextTaskStep(activeTask),
      activeTask.plan.goalConstraints,
    );
    activeTask.plannedSteps += 1;
    store.addProcessLog(
      "agent",
      "success",
      `次のサブタスク ${activeTask.plannedSteps}を計画しました`,
      JSON.stringify(activeTask.currentStep, null, 2),
    );
  }
  const step = activeTask.currentStep;
  activeTask.latestObservation = null;
  store.addProcessLog(
    "agent",
    "info",
    `サブタスク ${activeTask.plannedSteps}: ${step.instruction}`,
    JSON.stringify(step.constraints, null, 2),
  );
  const executionGoal = taskStepExecutionGoal(
    activeTask.goal,
    step,
    activeTask.plannedSteps,
    store.snapshot().currentUrl,
    activeTask.plan.goalConstraints,
  );
  const result = await runBrowserTask(executionGoal);
  return verifyAndAdvanceActiveStep(result);
}

export async function runTaskMode(goal: string): Promise<TaskModeResult> {
  if (activeTask?.goal === goal) return executeActiveTask();
  const plan = await createTaskPlan(goal);
  activeTask = {
    goal,
    plan,
    currentStep: null,
    completedSteps: [],
    goalEvidence: [],
    failedEvidence: [],
    stepAttempts: 0,
    plannedSteps: 0,
    replans: 0,
    latestObservation: null,
  };
  store.addProcessLog(
    "agent",
    "success",
    `タスクのゴール制約を作成しました (${plan.goalConstraints.length}件)`,
    JSON.stringify(plan, null, 2),
  );
  const initialObservation = await browserManager.taskObservation(plan.goalConstraints.map((constraint) => constraint.description).join(" "));
  activeTask.latestObservation = initialObservation;
  const initialVerification = await verifyTaskConstraints(plan.goalConstraints, initialObservation);
  activeTask.goalEvidence = initialVerification.results;
  const unmetGoals = failedConstraintResults(plan.goalConstraints, initialVerification);
  store.addProcessLog(
    "agent",
    unmetGoals.length === 0 ? "success" : "info",
    unmetGoals.length === 0 ? "Verifier: 全ゴール制約を確認しました" : `Verifier: 未達または証拠不足のゴールが${unmetGoals.length}件あります`,
    JSON.stringify({ constraints: plan.goalConstraints, results: initialVerification.results, model: initialVerification.model, durationMs: initialVerification.durationMs, observationRevision: initialVerification.observationRevision }, null, 2),
  );
  if (unmetGoals.length === 0) {
    activeTask = null;
    return {
      ok: true,
      steps: 0,
      currentUrl: store.snapshot().currentUrl,
      message: `${plan.summary} すべての構造化制約を画面上で確認しました。`,
    };
  }
  return executeActiveTask();
}

export async function resumeTaskModeAfterApproval(result: unknown): Promise<TaskModeResult> {
  if (!activeTask) return result as TaskModeResult;
  return verifyAndAdvanceActiveStep(result);
}

export function cancelTaskMode() {
  activeTask = null;
}