import { NextResponse } from "next/server";
import { z } from "zod";
import { runBrowserTask, vehicleModelRequest } from "@/lib/browser-task";
import { store } from "@/lib/store";

export const runtime = "nodejs";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(8000),
});

export async function POST(request: Request) {
  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_MESSAGE" }, { status: 400 });
  store.addMessage(parsed.data.role, parsed.data.content);
  let browserTask: Awaited<ReturnType<typeof runBrowserTask>> | null = null;
  if (parsed.data.role === "user" && vehicleModelRequest(parsed.data.content)) {
    try {
      browserTask = await runBrowserTask(parsed.data.content);
    } catch (error) {
      console.error("Deterministic voice browser task failed", error);
    }
  }
  return NextResponse.json({ state: store.snapshot(), browserTask });
}