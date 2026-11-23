// カルテの文章から、算定に要る事実を取り出す（spec FR-69。2026-11-07 ユーザー判断で B 案）
// 取り出すのは AI。ただし事実ごとに「カルテのどの言葉から取ったか」（quote）を付けさせ、カルテに実際にない言葉の事実は捨てる。
// 取り出した結果は本人が確かめて直してから使う。判定はユスティだけが行う（AI は判定しない）
import { modelOptions, type ModelChoice } from "../mentor/models";
import { runOnce, type Sender } from "../llm/outbound";
import { ACT_CATEGORIES, CHILD_KINDS, MAX_LOOKUP, validateActs } from "./acts";

/** 本人が書くカルテ（1 回の訪問） */
export type ChartNote = { s: string; o: string; a: string; p: string; rx: string };

/**
 * 取り出す事実。処方は分類名（DOAC など）、病名はカルテに書かれた名前、急性増悪は書かれているときだけ。
 * 不安・不眠の薬は、その日の処方に、処方箋料の区分 2 の対象になる不安・不眠の薬（EM #7-15）が含まれるか（value は「あり」か「なし」）。
 * 本人が確かめたうえで、その日の処方の出来事（psychotropic）に重ねる（src/chart/notes.ts。design.md §11-5）。長期処方に当たるかは読まない（医師が確かめる）
 */
export type ExtractedFact =
  | { kind: "処方"; value: string; quote: string }
  | { kind: "病名の記載"; value: string; quote: string }
  | { kind: "急性増悪"; value: string; quote: string }
  | { kind: "不安・不眠の薬"; value: string; quote: string };

export const FACT_KINDS = ["処方", "病名の記載", "急性増悪", "不安・不眠の薬"] as const;
/** 「不安・不眠の薬」の値 */
export const PSYCHOTROPIC_VALUES = ["あり", "なし"];

const LOOKUP_SCHEMA = { type: "array", items: { type: "string" }, maxItems: MAX_LOOKUP } as const;

export const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: { kind: { type: "string", enum: [...FACT_KINDS] }, value: { type: "string" }, quote: { type: "string" } },
        required: ["kind", "value", "quote"],
        additionalProperties: false,
      },
    },
    // 行ったこと（design.md §15-6。FR-192）。同じ 1 回の呼び出しで出す
    acts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...ACT_CATEGORIES] },
          written: { type: "string" },
          lookup: LOOKUP_SCHEMA,
          quantity: { type: "string" },
          quote: { type: "string" },
          with: {
            type: "array",
            items: {
              type: "object",
              properties: { kind: { type: "string", enum: [...CHILD_KINDS] }, written: { type: "string" }, lookup: LOOKUP_SCHEMA, quantity: { type: "string" }, quote: { type: "string" } },
              required: ["kind", "written", "lookup", "quote"],
              additionalProperties: false,
            },
          },
        },
        required: ["category", "written", "lookup", "quote"],
        additionalProperties: false,
      },
    },
    // その日の処方の記載（文を写すだけ。院内か院外かは分けさせない。C-231）
    rx: { type: "array", items: { type: "object", properties: { quote: { type: "string" } }, required: ["quote"], additionalProperties: false } },
  },
  required: ["facts", "acts", "rx"],
  additionalProperties: false,
} as const;

export const EXTRACT_PROMPT = [
  "あなたは在宅医療のカルテから、医療事務が算定に使う事実を取り出します。判定や助言はしない。",
  "事実（facts）として取り出すのは次の 4 種類だけ：",
  "- 処方：処方されている薬の分類名（例：DOAC、利尿薬、インスリン）。薬の名前で書かれていても分類名で value に入れる",
  "- 病名の記載：A（評価）などに書かれた病名や略語。value は書かれたとおり（略語を言い換えない）",
  "- 急性増悪：急性増悪・急変と書かれているときだけ。value は「あり」",
  "- 不安・不眠の薬：処方の欄に薬が書かれているときだけ。その日の処方に、不安や不眠に対して出される薬が含まれていれば value は「あり」、書かれている薬のどれも当たらなければ「なし」。quote は、もとにした処方の記載。いつから続いているか（長期の処方か）は判断しない",
  "どの事実にも quote を付ける。quote はカルテに書かれた文字をそのまま写した短い部分（言い換え・要約をしない）。",
  "書かれていないことは出さない。推測で病名・病型・処方を足さない。何もなければ facts は空にする。",
  "行ったこと（acts）：カルテに書かれた診療行為・検査・処置・注射・投薬・器材を、書かれた名前のまま written に出す。使った薬・器材の量が書かれていれば、書かれたとおり quantity に写す。その行為で使った薬・器材は with に出す。書かれていない行為を足さない。時間や回数から加算を推し量らない。算定できるかは判断しない。名前ごとに、基本マスターの名称にありそうな言い方を 5 個まで lookup に挙げる（コードは書かない）。どの行為にも quote を付ける。何もなければ acts は空にする。",
  // v32 で足す 5 文（design.md §15-6。L-162。特定のカルテの語を入れない）
  "訪問診療・往診を行ったと書かれていれば、それも行為として出す。処方の欄に書かれた薬は、1 つずつ投薬として acts にも出す（rx への写しとは別に出す）。酸素などのガスや材料は、薬ではなく器材として出す（with の中でも同じ）。まとめて書かれた複数の検査・項目は、1 つずつ分けて出す。挙げたい言い方が複数あるときは、空白でつながず、別々の lookup の語に分ける。",
  "処方（rx）：処方の記載があれば、その文をそのまま quote に出す。院内か院外かは分けない。書かれていなければ出さない（rx は空にする）。",
].join("\n");

/** カルテを 1 つの文章にする（AI に渡す形） */
export function noteText(n: ChartNote): string {
  return [`S: ${n.s}`, `O: ${n.o}`, `A: ${n.a}`, `P: ${n.p}`, `処方: ${n.rx}`].join("\n");
}

const squash = (s: string) => s.replace(/\s+/g, "");

/**
 * 取り出した結果を検査する（決まった規則）。
 * 形の違うもの、種類が範囲外のもの、quote がカルテにないもの（作り足しの疑い）は捨て、捨てた理由を返す
 */
export function validateFacts(raw: unknown, note: ChartNote): { facts: ExtractedFact[]; dropped: { fact: unknown; why: string }[] } {
  const text = squash(noteText(note));
  const list = (raw as { facts?: unknown } | null)?.facts;
  const facts: ExtractedFact[] = [];
  const dropped: { fact: unknown; why: string }[] = [];
  if (!Array.isArray(list)) return { facts, dropped: [{ fact: raw, why: "形が違う" }] };
  for (const f of list) {
    const o = f as Partial<ExtractedFact> | null;
    if (!o || typeof o.value !== "string" || typeof o.quote !== "string" || !o.value.trim() || !o.quote.trim()) dropped.push({ fact: f, why: "形が違う" });
    else if (!(FACT_KINDS as readonly string[]).includes(o.kind as string)) dropped.push({ fact: f, why: "取り出す種類の外" });
    else if (!text.includes(squash(o.quote))) dropped.push({ fact: f, why: "カルテにない言葉から取っている" });
    else if (o.kind === "不安・不眠の薬" && !PSYCHOTROPIC_VALUES.includes(o.value.trim())) dropped.push({ fact: f, why: "不安・不眠の薬は「あり」か「なし」で入れる" });
    else facts.push({ kind: o.kind as ExtractedFact["kind"], value: o.value.trim(), quote: o.quote.trim() });
  }
  return { facts, dropped };
}

/** カルテから事実と行ったこと・処方の記載を取り出す（LLM。1 回の呼び出し）。出力は validateFacts・validateActs を通してから返す */
export async function extractFacts(by: Sender, note: ChartNote, model?: ModelChoice) {
  const r = await runOnce(by, "chartExtract", noteText(note), {
    systemPrompt: EXTRACT_PROMPT,
    tools: [],
    settingSources: [],
    persistSession: false,
    outputFormat: { type: "json_schema", schema: EXTRACT_SCHEMA as unknown as Record<string, unknown> },
    maxTurns: 2,
    ...modelOptions(model),
  });
  const f = validateFacts(r.structured, note);
  const a = validateActs(r.structured, noteText(note));
  return { facts: f.facts, dropped: f.dropped, acts: a.acts, rx: a.rx, actsDropped: a.dropped };
}
