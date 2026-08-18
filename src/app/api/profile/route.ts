import { NextResponse } from "next/server";
import { z } from "zod";
import { runHistoryRecorder } from "@/lib/run-history-recorder";
import { store } from "@/lib/store";

const profileSchema = z.object({
  displayName: z.string().max(80).optional(),
  region: z.string().max(80).optional(),
  language: z.literal("ja-JP").optional(),
  budget: z.string().max(80).optional(),
  usage: z.string().max(120).optional(),
  bodyType: z.string().max(80).optional(),
  passengers: z.number().int().min(1).max(20).optional(),
  priorities: z.string().max(200).optional(),
  activityCollection: z.boolean().optional(),
  runHistoryCollection: z.boolean().optional(),
});

const operationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("clear_activity") }),
  z.object({ operation: z.literal("delete_interest"), id: z.string().uuid() }),
  z.object({ operation: z.literal("rename_interest"), id: z.string().uuid(), name: z.string().trim().min(1).max(80) }),
]);

export async function GET() {
  return NextResponse.json(store.snapshot());
}

export async function PUT(request: Request) {
  const parsed = profileSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_PROFILE", issues: parsed.error.issues }, { status: 400 });
  store.updateProfile(parsed.data);
  if (parsed.data.runHistoryCollection === false) await runHistoryRecorder.disableCollection();
  return NextResponse.json(store.snapshot());
}

export async function PATCH(request: Request) {
  const parsed = operationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_OPERATION" }, { status: 400 });

  if (parsed.data.operation === "clear_activity") store.clearActivity();
  if (parsed.data.operation === "delete_interest") store.deleteInterest(parsed.data.id);
  if (parsed.data.operation === "rename_interest") store.updateInterest(parsed.data.id, parsed.data.name);
  return NextResponse.json(store.snapshot());
}