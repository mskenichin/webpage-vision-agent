import { NextResponse } from "next/server";
import { z } from "zod";
import { runBrowserTask } from "@/lib/browser-task";
import { stopComputerUse } from "@/lib/computer-use";
import { delegateComplexQuery } from "@/lib/delegation";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 120;

const toolSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("delegate_complex_query"), arguments: z.object({ query: z.string().trim().min(1).max(4000) }) }),
  z.object({ name: z.literal("request_browser_task"), arguments: z.object({ goal: z.string().trim().min(1).max(2000) }) }),
]);

export async function POST(request: Request) {
  const parsed = toolSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_TOOL_CALL", issues: parsed.error.issues }, { status: 400 });
  try {
    if (parsed.data.name === "delegate_complex_query") {
      const state = store.snapshot();
      const result = await delegateComplexQuery(parsed.data.arguments.query, state.profile, state.messages, state.currentUrl);
      return NextResponse.json(result);
    }
    return NextResponse.json(await runBrowserTask(parsed.data.arguments.goal));
  } catch (error) {
    console.error("Realtime tool failed", error);
    return NextResponse.json({ code: "TOOL_UNAVAILABLE", message: "要求された処理を完了できませんでした。" }, { status: 502 });
  }
}

export async function DELETE() {
  stopComputerUse();
  return NextResponse.json(store.snapshot());
}