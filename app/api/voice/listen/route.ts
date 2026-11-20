// API Route（薄い入口）。本人が声で答えた名前を文字にする（spec FR-27）。結果は入力欄に入れ、本人が確かめてから決める
import { badRequest, UserError } from "../../../../src/server/errors";
import { route } from "../../../../src/server/http";
import { allow } from "../../../../src/server/policy";
import { listen } from "../../../../src/voice/elevenlabs";
import { toHiragana } from "../../../../src/voice/kana";
import { modelFor } from "../../../../src/mentor/models";

/** 音声の上限（名前だけなので短い） */
const MAX_AUDIO = 2_000_000;

/** multipart/form-data の audio（録音したもの）→ { text }。ログインした人だけ（利用料がかかるため。回数制限つき） */
export const POST = route({ roles: allow("POST /api/voice/listen"), form: { maxBytes: MAX_AUDIO + 4096 }, limit: "voice" }, async ({ form, user }) => {
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) throw badRequest("音声がない");
  if (audio.size > MAX_AUDIO) throw new UserError(413, "音声が長すぎる（名前だけを話してください）");
  // 漢字が混じっていたらひらがなの読みに直す（当て推量の漢字を避ける。2026-11-07 ユーザー判断）
  return { text: await toHiragana(user, await listen(user, audio), modelFor("nameKana")) };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
