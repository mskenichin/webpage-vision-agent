import { NextResponse } from "next/server";
import { transcribeAudio } from "@/lib/transcription";

export const runtime = "nodejs";
export const maxDuration = 120;

const maxAudioBytes = 25 * 1024 * 1024;
const allowedTypes = new Set(["audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"]);

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  const partial = form?.get("partial") === "true";
  const audioType = audio instanceof File ? audio.type.split(";", 1)[0] : "";
  if (!(audio instanceof File) || audio.size === 0 || audio.size > maxAudioBytes || !allowedTypes.has(audioType)) {
    return NextResponse.json({ code: "INVALID_AUDIO", message: "対応する25MB以下の音声を送信してください。" }, { status: 400 });
  }

  try {
    const text = await transcribeAudio(audio);
    if (!text && !partial) return NextResponse.json({ code: "NO_SPEECH", message: "音声を認識できませんでした。" }, { status: 422 });
    return NextResponse.json({ text });
  } catch (error) {
    console.error("Transcription failed", error);
    return NextResponse.json({ code: "TRANSCRIPTION_UNAVAILABLE", message: "文字起こしを完了できませんでした。" }, { status: 502 });
  }
}