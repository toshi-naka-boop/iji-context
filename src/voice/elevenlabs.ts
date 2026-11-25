// 初回にキャラを選んだときの声（spec FR-27）。読み上げと聞き取りは ElevenLabs。
// キーは環境変数 ELEVENLABS_API_KEY（.env.local）を SDK が読む。サーバー側だけで使う。
// 音声の API を呼ぶのは src/voice/ だけ（tests/llm/outbound.test.ts が縛る）。送る前に、AI のときと同じく、誰の操作かと注意書きへの同意を確かめる（design.md §11-11）
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { assertMaySend, type Sender } from "../llm/outbound";

const TTS_MODEL = "eleven_v4";
const STT_MODEL = "scribe_v2";

let client: ElevenLabsClient | null = null;
const el = () => (client ??= new ElevenLabsClient());

/** 文を声にする（mp3 のバイト列） */
export async function speak(by: Sender, voiceId: string, text: string): Promise<Uint8Array> {
  assertMaySend(by);
  const stream = await el().textToSpeech.convert(voiceId, { text, modelId: TTS_MODEL, languageCode: "ja" });
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 本人が声で答えた名前を文字にする。入力欄に入れて本人が確かめるので、ここでは整えない（前後の空白と句点だけ落とす） */
export async function listen(by: Sender, audio: Blob): Promise<string> {
  assertMaySend(by);
  const r = await el().speechToText.convert({ file: audio, modelId: STT_MODEL, languageCode: "jpn" });
  const text = "text" in r ? r.text : "";
  return text.trim().replace(/[。、.]+$/, "");
}
