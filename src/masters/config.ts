// config/masters.json の読み込み（design.md §12-1）：データごとの公開ページ・入手先・ファイル名の形・文字コード・項目数と、改定の世代
import { z } from "zod";
import raw from "../../config/masters.json";

const https = z.string().regex(/^https:\/\/[a-z0-9.-]+\//, "https の URL");
const download = z.strictObject({
  /** 決まった URL から落とす（url か href のどちらか 1 つ） */
  url: https.optional(),
  /** 公開ページの中のリンク（href）の形（正規表現）。更新のたびにファイル名が変わる公開元は、ページから探す */
  href: z.string().optional(),
  /** 更新日をどこから取るか：file＝中のファイル名／link＝リンク（href と文字） */
  dateFrom: z.enum(["file", "link"]),
  /** 更新日を取り出す正規表現。かっこ 1 つなら西暦 8 桁、3 つなら令和の年・月・日 */
  date: z.string(),
});
const dataset = z.strictObject({
  title: z.string(),
  publisher: z.string(),
  /** 公開ページ */
  page: https,
  download: download.refine((d) => (d.url === undefined) !== (d.href === undefined), "url か href のどちらか 1 つ"),
  /** 読み取りは Shift_JIS に決め打ち（src/masters/csv.ts）なので、値は読まない。残す理由：公開元が文字コードを変えたら、config の読み込みで止まるように（round-32 O-20） */
  encoding: z.literal("shift_jis"),
  /** この日（西暦 8 桁）より前の更新分は、この世代のデータとして扱わない */
  since: z.string().regex(/^\d{8}$/).optional(),
  /** 取り込むファイル。layout は src/masters/layout.ts の表の id、name はファイル名の形、fields は 1 行の項目数 */
  files: z.array(z.strictObject({ layout: z.string(), name: z.string(), fields: z.number().int().positive() })).min(1),
});
const schema = z.strictObject({
  /** 改定の世代（Revision.generation）。いま持つのは 1 つだけ */
  generation: z.string(),
  datasets: z.record(z.string().regex(/^[a-z_]+$/), dataset),
});

export type MastersConfig = z.infer<typeof schema>;
export type DatasetConfig = z.infer<typeof dataset>;
export const MASTERS_CONFIG: MastersConfig = schema.parse(raw);

/** 更新日（西暦 8 桁）を取り出す。合わなければ null。令和 n 年は 2018 + n 年 */
export function snapshotOf(pattern: string, s: string): string | null {
  const m = new RegExp(pattern).exec(s);
  if (!m) return null;
  const d = m.length === 4 ? `${2018 + Number(m[1])}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}` : (m[1] ?? "");
  return /^\d{8}$/.test(d) ? d : null;
}
