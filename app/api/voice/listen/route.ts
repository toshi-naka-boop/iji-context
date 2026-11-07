// API Route（薄い入口）。本人が声で答えた名前を文字にする（spec FR-27）。結果は入力欄に入れ、本人が確かめてから決める
import { authed } from "../../../../src/server/http";
import { listen } from "../../../../src/voice/elevenlabs";

/** multipart/form-data の audio（録音したもの）→ { text }。ログインした人だけ（利用料がかかるため） */
export async function POST(req: Request) {
  return authed(req, async () => {
    const audio = (await req.formData()).get("audio");
    if (!(audio instanceof Blob) || audio.size === 0) throw new Error("音声がない");
    if (audio.size > 2_000_000) throw new Error("音声が長すぎる（名前だけを話してください）");
    return { text: await listen(audio) };
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
