// 自由に書いたカルテを SOAP の欄に整える（2026-11-07 ユーザー判断。モデルは Haiku：config/models.json の chartSoap）
// AI は並べ替えるだけで、書かれていないことを足さない。足していないかを決まった規則で検査し、原文にない言い回しは画面で知らせる。
// 整えた結果は本人が欄ごとに直せる。そのあとの事実の取り出し（extract.ts）は今までどおり
import { modelOptions, type ModelChoice } from "../mentor/models";
import { runOnce } from "../mentor/run";
import type { ChartNote } from "./extract";

export const SOAP_SCHEMA = {
  type: "object",
  properties: { s: { type: "string" }, o: { type: "string" }, a: { type: "string" }, p: { type: "string" }, rx: { type: "string" } },
  required: ["s", "o", "a", "p", "rx"],
  additionalProperties: false,
} as const;

export const SOAP_PROMPT = [
  "あなたは在宅医療の訪問カルテを、SOAP の欄に振り分けます。判定や助言はしない。",
  "- s：患者さん・家族の訴え　o：診察や観察で分かったこと　a：評価・病名　p：計画・方針　rx：処方（薬の名前・分類）",
  "- 書かれた言葉をそのまま使う。言い換え・要約・補足をしない。書かれていないこと（病名・薬・数値・経過）を足さない",
  "- 一つの文が二つの欄にまたがるときは、文を分けてよい。どの欄にも当たらない言葉は p に入れる",
  "- 当てはまる言葉がない欄は空の文字列にする",
].join("\n");

const squash = (s: string) => s.replace(/[\s。、，．・：:]/g, "");

/** 整えた欄の中で、原文に見当たらない言い回し（作り足しの疑い）を返す。決まった規則だけで行う */
export function unmatchedPhrases(note: ChartNote, original: string): string[] {
  const src = squash(original);
  return Object.values(note)
    .flatMap((v) => v.split(/[。\n、]/))
    .map((x) => x.trim())
    .filter((x) => squash(x) && !src.includes(squash(x)));
}

/** 形の違う出力は空の欄にする */
function toNote(raw: unknown): ChartNote {
  const o = (raw ?? {}) as Partial<Record<keyof ChartNote, unknown>>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { s: str(o.s), o: str(o.o), a: str(o.a), p: str(o.p), rx: str(o.rx) };
}

/** 自由記述を SOAP に整える（LLM）。原文にない言い回しも一緒に返す */
export async function formatSoap(text: string, model?: ModelChoice): Promise<{ note: ChartNote; unmatched: string[] }> {
  if (!text.trim()) throw new Error("カルテが空です");
  const r = await runOnce("chartSoap", text, {
    systemPrompt: SOAP_PROMPT,
    tools: [],
    settingSources: [],
    persistSession: false,
    outputFormat: { type: "json_schema", schema: SOAP_SCHEMA as unknown as Record<string, unknown> },
    maxTurns: 2,
    ...modelOptions(model),
  });
  const note = toNote(r.structured);
  return { note, unmatched: unmatchedPhrases(note, text) };
}
