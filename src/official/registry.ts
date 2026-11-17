// 公的情報レジストリの読み込みと検査（FR-124〜127）。official/<id>.json を 1 文書 1 ファイルで持つ
// レジストリに置けるのは evidence-master §2-4 の表にある文書だけ（表との突き合わせは tests/official/registry.test.ts）
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ruleKubun } from "../engine";
import { isKnownKubun } from "../engine/codes-fictional";
import { hasRevision, resolveRevision } from "../engine/revisions";
import type { OfficialDoc, OfficialInput } from "./types";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const kubun = z.string().refine(isKnownKubun, "架空コードの表にない区分");

/** 要旨の上限（設計パラメータ。FR-125） */
export const SUMMARY_MAX = 200;

export const officialDocSchema = z.strictObject({
  id: z.string().regex(/^[A-Z0-9][A-Za-z0-9-]{0,39}$/),
  kind: z.enum(["疑義解釈", "審査の一般的な取扱い", "審査情報提供事例"]),
  issuer: z.string().min(1).max(100),
  number: z.string().min(1).max(100),
  issuedOn: date,
  url: z.string().max(500).regex(/^https:\/\//),
  scope: z.strictObject({
    kubun: z.array(kubun).min(1).max(20),
    payer: z.enum(["支払基金", "国保連"]).nullable(),
    prefecture: z.string().min(1).max(10).nullable(),
    facts: z
      .strictObject({ careLevelMin: z.number().int(), insurance: z.string().max(20), table8_2: z.boolean(), table7: z.boolean() })
      .partial()
      .optional(),
    commentOn: z.array(z.strictObject({ kubun, present: z.boolean() })).max(20).optional(),
    consecutiveMonths: z.strictObject({ kubun, min: z.number().int().min(1) }).optional(),
    conditionNote: z.string().min(1).max(200).nullable(),
  }),
  stance: z.enum(["認める", "認めない", "条件つき"]),
  // 要旨は自前の文で、点数・金額を含めない
  summary: z
    .string()
    .min(1)
    .max(SUMMARY_MAX)
    .refine((s) => !/[0-9０-９]\s*(点|円)/.test(s), "要旨に点数・金額を書かない"),
  checkedOn: date,
  generations: z.array(z.string().min(1).max(10)).min(1).max(10),
});

/** official/ の全文書（id 昇順）。形が違う・ファイル名と id が違うときは例外（起動を止める）。ファイル名が id なので、同じ id は 2 つ置けない */
export function loadRegistry(dir: string): OfficialDoc[] {
  const docs: OfficialDoc[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = officialDocSchema.safeParse(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
    if (!parsed.success) throw new Error(`公的文書の形が違う: ${file}（${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("、")}）`);
    if (`${parsed.data.id}.json` !== file) throw new Error(`公的文書のファイル名と id が違う: ${file}`);
    // tsconfig が strict でないので、zod の推論は null を許す欄を省略可として出す。検査は済んでいるので型を合わせる
    docs.push(parsed.data as OfficialDoc);
  }
  return docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 本番の配線が作る、トリガー④と議題に渡す入力（同梱の版から世代とルールの区分を引く） */
export function officialInputOf(root: string): OfficialInput {
  return {
    docs: loadRegistry(path.join(root, "official")),
    generationOf: (yearMonth) => (hasRevision(yearMonth) ? resolveRevision(yearMonth).generation : null),
    ruleKubun: (ruleId, yearMonth) => ruleKubun(ruleId, yearMonth),
  };
}
