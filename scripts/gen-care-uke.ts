// 介護保険・ほかの医療機関との調整の合成の UKE（fixtures/care/kaigo.UKE）を書き出す（design.md §18-7。v37 21e）。`npx tsx scripts/gen-care-uke.ts`
// 設定は fixtures/care/kaigo.json（症例 K25〜K31。EM §5-1 の行）。請求は基準月の分と、K26 の前の月の分（利用前 30 日の当院の訪問を見るため）。出力は設定だけで決まる。
// 申告（聞き取りの画面で答える内容）は UKE に入らない。アップロードして、聞き取りの画面で答えて試す。
// 誤りを含む請求（R20・R21 の場面のほか、データで動く点検の記載もれ・背反も出る）なので、正しい請求として並べる同梱の見本（fixtures/uke）とは別の置き場に置く
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monthFrom, period } from "../src/demo/period";
import type { UkeFile, UkeReceipt } from "../src/uke/types";
import { readUke, writeUke } from "../src/uke/uke";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const KAIGO_FILE = "fixtures/care/kaigo.UKE";

type Line = { kubun: string; days: number[] };
export type KaigoCase = { id: string; name: string; lines: Line[]; prev?: Line[]; declare: Record<string, unknown>; expected: string[] };
export type Kaigo = { patientNo: string; homes: Record<string, unknown>[]; basis: { checkedOn: { m: number; d: number }; source: string }; cases: KaigoCase[] };

export const loadKaigo = (): Kaigo => JSON.parse(readFileSync(path.join(root, "fixtures", "care", "kaigo.json"), "utf8")) as Kaigo;

/** 基準月から m か月ずらした月の d 日 */
export const dateOf = (m: number, d: number): string => `${monthFrom(m)}-${String(d).padStart(2, "0")}`;

export function kaigoFile(): UkeFile {
  const cfg = loadKaigo();
  const base = readUke(readFileSync(path.join(root, "fixtures", "uke", "shiharaikikin.UKE")));
  const r0 = base.receipts[0];
  const receipt = (c: KaigoCase, i: number, m: number, lines: Line[]): UkeReceipt => ({
    ...r0,
    claimId: c.id,
    patientNo: c.id,
    yearMonth: monthFrom(m),
    patient: { ...r0.patient, name: c.name, birth: "19400101", insurer: { ...r0.patient.insurer, symbol: "77", no: String(2500 + i) } },
    lines: lines.map((l) => ({ kubun: l.kubun, count: l.days.length, dates: l.days.map((d) => dateOf(m, d)) })),
    comments: [],
  });
  const receipts = cfg.cases.flatMap((c, i) => [...(c.prev ? [receipt(c, i, -1, c.prev)] : []), receipt(c, i, 0, c.lines)]);
  return { ...base, billingMonth: period.billingMonth, receipts };
}

export const generateKaigo = (): Buffer => writeUke(kaigoFile());

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  writeFileSync(path.join(root, KAIGO_FILE), generateKaigo());
  console.log(`書き出した: ${KAIGO_FILE}`);
}
