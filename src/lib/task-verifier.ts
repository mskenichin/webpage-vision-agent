import { DefaultAzureCredential } from "@azure/identity";
import { z } from "zod";
import { browserManager } from "./browser";

export const taskConstraintSchema = z.object({
  id: z.string().trim().min(1).max(80),
  target: z.object({
    kind: z.enum(["page", "url", "selection", "value", "collection"]),
    label: z.string().trim().min(1).max(200),
  }),
  operator: z.enum([
    "visible",
    "not_visible",
    "selected",
    "not_selected",
    "equals",
    "contains",
    "all_available_selected",
    "count_equals",
    "greater_than_or_equal",
    "less_than_or_equal",
  ]),
  expected: z.union([z.string(), z.number(), z.boolean()]).optional(),
  evidence: z.array(z.enum(["screenshot", "page_text", "url"])).min(1).max(3),
  description: z.string().trim().min(1).max(500),
});

export type TaskConstraint = z.infer<typeof taskConstraintSchema>;

const constraintResultSchema = z.object({
  id: z.string().trim().min(1).max(80),
  passed: z.boolean(),
  evidence: z.string().trim().min(1).max(1000),
});

export const verificationResultSchema = z.object({
  results: z.array(constraintResultSchema).min(1).max(20),
});

export type VerificationResult = z.infer<typeof verificationResultSchema>;

export function parseVerificationResult(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return verificationResultSchema.parse(JSON.parse((fenced ?? text).trim()));
}

export function failedConstraintResults(constraints: TaskConstraint[], verification: VerificationResult) {
  const results = new Map(verification.results.map((result) => [result.id, result]));
  return constraints.flatMap((constraint) => {
    const result = results.get(constraint.id);
    return result?.passed ? [] : [{ constraint, evidence: result?.evidence ?? "Verifierから判定結果が返されませんでした。" }];
  });
}

async function requestVerification(model: string, constraints: TaskConstraint[], signal: AbortSignal) {
  const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT?.replace(/\/$/, "");
  if (!endpoint) throw new Error("MODEL_UNAVAILABLE");
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  if (!token) throw new Error("MODEL_UNAVAILABLE");
  const [screenshot, pageContext] = await Promise.all([
    browserManager.computerScreenshot(),
    browserManager.pageContext(constraints.map((constraint) => constraint.description).join(" "), false),
  ]);
  const response = await fetch(`${endpoint}/openai/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      instructions: `あなたはWeb操作結果を検証する独立Verifierです。各制約を最新画面の明示的な証拠だけで個別判定してください。
推測、一般知識、操作担当モデルの自己申告は使わないでください。指定されたevidenceに証拠がない場合はpassed=falseにしてください。
selectionとcollectionは、ラベル、選択中表示、チェック状態、件数などを画面で確認してください。
selectionのequals、contains、selectedは、後続画面の車両名、構成内容、選択済み要約に期待値が明示されていれば合格にできます。元の選択肢UIやチェック状態が現在画面にないことだけを理由に不合格にしないでください。
「要求に含まれない追加オプションが0件」のcount_equals制約では、項目名だけでなく画面に明示されたカテゴリ表示も照合してください。ユーザー要求にないカテゴリに属する選択済み項目が1件でも見える場合はpassed=falseとし、その項目名とカテゴリをevidenceへ記録してください。
JSON以外を出力せず、次の形式に厳密に従ってください: {"results":[{"id":"constraint-id","passed":true,"evidence":"確認した具体的な画面状態"}]}`,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: `検証制約:\n${JSON.stringify(constraints)}\n現在URL: ${pageContext.url}\nページ本文:\n${pageContext.text}` },
          { type: "input_image", image_url: `data:image/jpeg;base64,${screenshot.toString("base64")}` },
        ],
      }],
      store: false,
    }),
  });
  if (!response.ok) throw new Error(`MODEL_UNAVAILABLE:${response.status}`);
  const payload = await response.json() as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  const text = payload.output?.flatMap((item) => item.content ?? [])
    .find((content) => content.type === "output_text")?.text?.trim();
  if (!text) throw new Error("MODEL_UNAVAILABLE:EMPTY_VERIFICATION");
  return parseVerificationResult(text);
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

export async function verifyTaskConstraints(constraints: TaskConstraint[]) {
  const primary = process.env.AZURE_EXPERT_MODEL ?? "gpt-5.6-sol";
  const fallback = process.env.AZURE_CHAT_MODEL ?? "gpt-5.4";
  try {
    return await withTimeout(15_000, (signal) => requestVerification(primary, constraints, signal));
  } catch {
    return withTimeout(20_000, (signal) => requestVerification(fallback, constraints, signal));
  }
}