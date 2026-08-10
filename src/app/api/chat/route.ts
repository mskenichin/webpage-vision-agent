import { NextResponse } from "next/server";
import { z } from "zod";
import { runAgent } from "@/lib/agent";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 120;

const messageSchema = z.object({ message: z.string().trim().min(1).max(4000) });

export async function POST(request: Request) {
  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_MESSAGE" }, { status: 400 });

  store.addMessage("user", parsed.data.message);
  try {
    const content = await runAgent(parsed.data.message);
    store.addMessage("assistant", content);
    return NextResponse.json(store.snapshot());
  } catch (error) {
    store.setBrowser("ready");
    const message = error instanceof Error ? error.message : "操作を完了できませんでした。";
    if (message === "AGENT_STOPPED") {
      store.addMessage("system", "操作を停止しました。");
      return NextResponse.json(store.snapshot());
    }
    store.addMessage("system", `操作を停止しました: ${message}`);
    return NextResponse.json(store.snapshot(), { status: 502 });
  }
}