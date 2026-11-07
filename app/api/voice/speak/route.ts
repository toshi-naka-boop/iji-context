// API Route（薄い入口）。初回にキャラを選んだときの声を読み上げる（spec FR-27）。台詞は config/voice-lines.json
import { readFileSync } from "node:fs";
import path from "node:path";
import { authedResponse } from "../../../../src/server/http";
import { characterOf } from "../../../../src/server/instance";
import { speak } from "../../../../src/voice/elevenlabs";

type Line = "intro" | "askName" | "greeting" | "greetingNoName";
const LINES: Line[] = ["intro", "askName", "greeting", "greetingNoName"];

/** POST { characterId, line, name? } → audio/mpeg。読み上げるのは決まった台詞だけ（任意の文は受け付けない）。ログインした人だけ（利用料がかかるため） */
export async function POST(req: Request) {
  return authedResponse(req, async () => {
    const b = (await req.json()) as { characterId: string; line: Line; name?: string };
    if (!LINES.includes(b.line)) throw new Error(`台詞がない: ${b.line}`);
    const voiceId = characterOf(b.characterId).voiceId;
    if (!voiceId) throw new Error(`声が決まっていない: ${b.characterId}`);
    const all = JSON.parse(readFileSync(path.join(process.cwd(), "config", "voice-lines.json"), "utf8")) as { lines: Record<string, Record<Line, string>> };
    const name = (b.name ?? "").trim().slice(0, 20);
    const text = all.lines[b.characterId]?.[b.line]?.replace("{name}", name);
    if (!text || (b.line === "greeting" && !name)) throw new Error("読み上げる台詞がない");
    const audio = await speak(voiceId, text);
    return new Response(audio as BodyInit, { headers: { "content-type": "audio/mpeg" } });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
