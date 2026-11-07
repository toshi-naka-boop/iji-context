// 声で答えた名前に漢字が混じっていたら、ひらがなの読みに直す（2026-11-07 ユーザー判断。モデルは Haiku：config/models.json の nameKana）。
// 聞き取りは音しか分からないので、漢字は当て推量になりやすく、あいさつの読み上げでも読み違えやすい。
// 返ってきた文字がひらがなだけでなければ、聞き取ったままを返す。入力欄で本人が直してから決めるのは今までどおり
import { modelOptions, type ModelChoice } from "../mentor/models";
import { runOnce } from "../mentor/run";

const KANJI = /[㐀-鿿豈-﫿]/;
const HIRAGANA_ONLY = /^[ぁ-ゖー\s]+$/;

export const KANA_SCHEMA = {
  type: "object",
  properties: { reading: { type: "string" } },
  required: ["reading"],
  additionalProperties: false,
} as const;

export const KANA_PROMPT = "渡された人の名前（呼び名）の読みを、ひらがなだけで reading に入れる。名前以外の言葉を足さない。敬称（さん・様）は落とす。";

/** 漢字が混じっているときだけ直す必要がある */
export const needsKana = (text: string) => KANJI.test(text);

/** モデルの答えを検査する（決まった規則）。ひらがなと「ー」だけなら読み、それ以外は聞き取ったまま */
export function acceptReading(raw: unknown, original: string): string {
  const r = typeof (raw as { reading?: unknown } | null)?.reading === "string" ? (raw as { reading: string }).reading.trim() : "";
  return r && r.length <= 20 && HIRAGANA_ONLY.test(r) ? r.replace(/\s+/g, "") : original;
}

/** 聞き取った名前をひらがなにする。漢字がなければそのまま、失敗したら聞き取ったまま */
export async function toHiragana(text: string, model?: ModelChoice): Promise<string> {
  if (!needsKana(text)) return text;
  try {
    const r = await runOnce("nameKana", text, {
      systemPrompt: KANA_PROMPT,
      tools: [],
      settingSources: [],
      persistSession: false,
      outputFormat: { type: "json_schema", schema: KANA_SCHEMA as unknown as Record<string, unknown> },
      maxTurns: 2,
      ...modelOptions(model),
    });
    return acceptReading(r.structured, text);
  } catch {
    return text;
  }
}
