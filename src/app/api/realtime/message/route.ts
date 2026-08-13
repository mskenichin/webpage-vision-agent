import { NextResponse } from "next/server";
import { z } from "zod";
import { browserManager } from "@/lib/browser";
import { requiresBrowserTask, runBrowserTask } from "@/lib/browser-task";
import { store } from "@/lib/store";
import { runTaskMode, type TaskModeResult } from "@/lib/task-mode";

export const runtime = "nodejs";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(8000),
  mode: z.enum(["normal", "task"]).default("normal"),
});

export async function POST(request: Request) {
  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_MESSAGE" }, { status: 400 });
  store.addMessage(parsed.data.role, parsed.data.content);
  store.addProcessLog(
    "realtime",
    "success",
    parsed.data.role === "user"
      ? `音声入力の文字起こしを確定しました (${parsed.data.mode === "task" ? "タスクモード" : "通常モード"})`
      : "Realtime LLM応答を受信しました",
    parsed.data.role === "assistant" ? parsed.data.content : undefined,
  );
  let browserTask: Awaited<ReturnType<typeof runBrowserTask>> | TaskModeResult | null = null;
  if (parsed.data.role === "user" && requiresBrowserTask(parsed.data.content, store.snapshot().currentUrl)) {
    try {
      store.addProcessLog("browser", "info", "音声要求に対応するページを探索しています");
      browserTask = parsed.data.mode === "task"
        ? await runTaskMode(parsed.data.content)
        : await runBrowserTask(parsed.data.content);
      store.addProcessLog("browser", "success", "音声要求のブラウザ操作が完了しました", browserTask.message);
    } catch (error) {
      console.error("Deterministic voice browser task failed", error);
      const detail = error instanceof Error ? error.message : "不明なエラー";
      store.addProcessLog("browser", "error", "音声要求のブラウザ操作を完了できませんでした", detail);
      browserTask = {
        ok: false,
        steps: 0,
        currentUrl: store.snapshot().currentUrl,
        message: "ブラウザ操作中にエラーが発生しました。画面は変更されていません。",
      };
    }
  }
  if (parsed.data.role === "user" && !browserTask) {
    await browserManager.revealRelevantContent(parsed.data.content).catch(() => undefined);
  }
  const pageContext = await browserManager.pageContext(parsed.data.content, parsed.data.role === "user").catch(() => undefined);
  return NextResponse.json({ state: store.snapshot(), browserTask, pageContext });
}