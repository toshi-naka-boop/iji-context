// 電子カルテの画面を撮った画像から、病名・診療記録・処方の文字を書き写す（2026-11-08 ユーザー判断。モデルは config/models.json の chartImage）
// AI は書き写すだけで、要約・補足・判定をしない。書き写した文は自由記述の欄に入り、本人が目で確かめてから SOAP に整える。
// 画像はどこにも保存しない（読み取ったら捨てる）
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { modelOptions, type ModelChoice } from "../mentor/models";
import { runOnce } from "../mentor/run";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageType = "image/png" | "image/jpeg" | "image/webp";

/** 先頭のバイト列で画像の種類を決める。PNG・JPEG・WebP 以外は null */
export function imageTypeOf(buf: Buffer): ImageType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export const CHART_IMAGE_SCHEMA = {
  type: "object",
  properties: {
    diseases: { type: "string" },
    record: { type: "string" },
    rx: { type: "string" },
    unreadable: { type: "boolean" },
  },
  required: ["diseases", "record", "rx", "unreadable"],
  additionalProperties: false,
} as const;

export const CHART_IMAGE_PROMPT = [
  "あなたは電子カルテの画面の画像から、文字を書き写します。判定や助言はしない。",
  "- diseases：病名の欄に書かれた病名（主病の印があれば「（主）」を付ける）。複数は「、」で区切る",
  "- record：診療記録（カルテ本文）の欄に書かれた文。改行もそのまま",
  "- rx：処方の欄に書かれた薬の名前・分類と用法",
  "- 画面に書かれた言葉をそのまま使う。言い換え・要約・補足をしない。読めない文字や画面にないことを推測で埋めない",
  "- 予約・メモ・オーダー・ボタンなど、上の 3 つ以外の欄は書き写さない",
  "- 当てはまる欄がない・読めないときは空の文字列にする。電子カルテの画面でない、または文字がほとんど読めないときは unreadable を true にする",
].join("\n");

export type ChartImageText = { diseases: string; record: string; rx: string; unreadable: boolean };

/** 形の違う出力は空の欄にする */
export function toImageText(raw: unknown): ChartImageText {
  const o = (raw ?? {}) as Partial<Record<keyof ChartImageText, unknown>>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { diseases: str(o.diseases), record: str(o.record), rx: str(o.rx), unreadable: o.unreadable === true };
}

/** 書き写した 3 つの欄を、自由記述の欄に入れる 1 つの文にする */
export function toFreeText(t: ChartImageText): string {
  return [t.record, t.diseases && `病名：${t.diseases}`, t.rx && `処方：${t.rx}`].filter(Boolean).join("\n");
}

/** 画像を Claude に読ませ、書き写した文を返す（画像は保存しない） */
export async function readChartImage(image: Buffer, model?: ModelChoice): Promise<{ text: string; parts: ChartImageText }> {
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES) throw new Error("画像が空か、5MB を超えています");
  const mediaType = imageTypeOf(image);
  if (!mediaType) throw new Error("PNG・JPEG・WebP の画像を選んでください");
  async function* prompt(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image.toString("base64") } },
          { type: "text", text: "この電子カルテの画面から、病名・診療記録・処方を書き写してください。" },
        ],
      },
    } as SDKUserMessage;
  }
  const r = await runOnce("chartImage", prompt(), {
    systemPrompt: CHART_IMAGE_PROMPT,
    tools: [],
    settingSources: [],
    persistSession: false,
    outputFormat: { type: "json_schema", schema: CHART_IMAGE_SCHEMA as unknown as Record<string, unknown> },
    maxTurns: 2,
    ...modelOptions(model),
  });
  const parts = toImageText(r.structured);
  if (parts.unreadable || !toFreeText(parts)) throw new Error("画像からカルテの文字を読み取れませんでした。電子カルテの画面を撮った画像か、文字が読める大きさかを確かめてください");
  return { text: toFreeText(parts), parts };
}
