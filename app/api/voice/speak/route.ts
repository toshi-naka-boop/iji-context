// API Route（薄い入口）。初回にキャラを選んだときの声を読み上げる（spec FR-27）。台詞は config/voice-lines.json
import { readFileSync } from "node:fs";
import path from "node:path";
import { badRequest } from "../../../../src/server/errors";
import { route } from "../../../../src/server/http";
import { characterOf } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { speakBody, VOICE_LINES } from "../../../../src/server/schemas/voice";
import { speak } from "../../../../src/voice/elevenlabs";

type Line = (typeof VOICE_LINES)[number];

/** POST { characterId, line, name? } → audio/mpeg。読み上げるのは決まった台詞だけ（任意の文は受け付けない）。ログインした人だけ（利用料がかかるため。回数制限つき） */
export const POST = route({ roles: allow("POST /api/voice/speak"), body: speakBody, limit: "voice", audit: { target: ({ body }) => `${body.characterId}:${body.line}` } }, async ({ body: b }) => {
  const voiceId = characterOf(b.characterId).voiceId;
  if (!voiceId) throw badRequest(`声が決まっていない: ${b.characterId}`);
  const all = JSON.parse(readFileSync(path.join(process.cwd(), "config", "voice-lines.json"), "utf8")) as { lines: Record<string, Record<Line, string>> };
  const name = (b.name ?? "").trim().slice(0, 20);
  const text = all.lines[b.characterId]?.[b.line]?.replace("{name}", name);
  if (!text || (b.line === "greeting" && !name)) throw badRequest("読み上げる台詞がない");
  const audio = await speak(voiceId, text);
  return new Response(audio as BodyInit, { headers: { "content-type": "audio/mpeg" } });
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
