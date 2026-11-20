// 合成 UKE 2 本を fixtures/uke/ に書き出す（spec FR-05）。`npx tsx scripts/gen-uke.ts`
// 入力は fixtures/cases/K1〜K7.json と fixtures/uke/patients.json。出力は入力だけで決まる。
// 見本の 2 本とは別に、アップロードで試すための合成の UKE も 2 本書き出す（design.md §11-11。設定は fixtures/uke/extra.json、値は EM 5-1 の表）：
// 点検の対象外の行を含むもの（taishogai.UKE）と、必須の記載を 1 つ欠いたもの（kisaimore.UKE）
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { period } from "../src/demo/period";
import type { ClaimContext } from "../src/engine/types";
import { buildUkeFiles, type UkeSources } from "../src/uke/cases";
import type { UkeFile } from "../src/uke/types";
import { encodeUke, formatUke, writeUke } from "../src/uke/uke";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** K7 は後期高齢者なので、国保連用の UKE に入る（保険者番号で決まる。design.md §1） */
export const CASES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"];
export const UKE_FILES = { 国保連: "fixtures/uke/kokuhoren.UKE", 支払基金: "fixtures/uke/shiharaikikin.UKE" } as const;
/** 請求年月（基準月の診療分を翌月に請求。config/demo.json） */
export const BILLING_MONTH = period.billingMonth;

export function loadSources(): { cases: ClaimContext[]; src: UkeSources } {
  const cases = CASES.map((k) => JSON.parse(readFileSync(path.join(root, "fixtures", "cases", `${k}.json`), "utf8")) as ClaimContext);
  const src = JSON.parse(readFileSync(path.join(root, "fixtures", "uke", "patients.json"), "utf8")) as UkeSources;
  return { cases, src };
}

export function generate(): Record<keyof typeof UKE_FILES, Buffer> {
  const { cases, src } = loadSources();
  const files = buildUkeFiles(cases, src, BILLING_MONTH);
  return { 国保連: writeUke(files.国保連), 支払基金: writeUke(files.支払基金) };
}

type ExtraPatient = { name: string; sex: 1 | 2; birth: string; insurerNo: string };
type Extra = {
  taishogai: { file: string; base: string; patientNo: string; patient: ExtraPatient; extraUnit: { day: number; shikibetsu: string; codes: string[]; points: number } };
  kisaimore: { file: string; base: string; patientNo: string; patient: ExtraPatient; dropComment: string };
};
export const EXTRA = JSON.parse(readFileSync(path.join(root, "fixtures", "uke", "extra.json"), "utf8")) as Extra;

/** 同梱の症例 1 つを、別の合成の患者のレセプト 1 件の UKE にする（「カルテ番号等」の欄は患者の番号）。行・事実・傷病名・検査項目・記載の値は、もとの症例のまま */
function extraFile(e: { base: string; patientNo: string; patient: ExtraPatient }): UkeFile {
  const { cases, src } = loadSources();
  const base = cases.find((c) => c.claimId.split("-")[0] === e.base);
  if (!base) throw new Error(`もとの症例がない: ${e.base}`);
  const from = src.patients[base.claimId];
  const patient = { ...from, name: e.patient.name, sex: e.patient.sex, birth: e.patient.birth, insurer: { ...from.insurer, no: e.patient.insurerNo } };
  const only: UkeSources = {
    clinic: src.clinic,
    patients: { [e.patientNo]: patient },
    bundleItems: { [e.patientNo]: src.bundleItems?.[base.claimId] ?? {} },
    commentValues: { [e.patientNo]: src.commentValues?.[base.claimId] ?? {} },
  };
  return buildUkeFiles([{ ...base, claimId: e.patientNo }], only, BILLING_MONTH)[base.payer];
}

/**
 * 見本以外で試す合成の UKE（design.md §11-11。EM 5-1 の表）。
 * taishogai：もとの症例に、扱っていない実在の診療行為コードを含む算定単位を 1 つ足す（単位の最後の行に 1 回分の点数。HO・GO の合計にも足す）。取り込むと、その単位が点検の対象外になる。
 * kisaimore：もとの症例から、必須の記載のコメントを 1 つ外す。取り込んだレセプトの点検で、記載もれが 1 件出る
 */
export function generateExtra(): Record<keyof Extra, Buffer> {
  const t = EXTRA.taishogai;
  const u = t.extraUnit;
  const rows = formatUke(extraFile(t)).split("\r\n");
  const cell = (row: string, col: number, f: (v: string) => string) => row.split(",").map((v, i) => (i === col - 1 ? f(v) : v)).join(",");
  const add = (v: string) => String(Number(v) + u.points);
  const futan = rows.find((r) => r.startsWith("SI,"))!.split(",")[2];
  const unit = u.codes.map((code, i) => {
    // SI は 44 列：診療識別（単位の先頭の行だけ）・負担区分・コード・数量データ・点数（単位の最後の行だけ）・回数、算定日情報は 14 列目から
    const c: string[] = Array.from({ length: 44 }, () => "");
    [c[0], c[1], c[2], c[3], c[5], c[6], c[12 + u.day]] = ["SI", i === 0 ? u.shikibetsu : "", futan, code, i === u.codes.length - 1 ? String(u.points) : "", "1", "1"];
    return c.join(",");
  });
  const go = rows.findIndex((r) => r.startsWith("GO,"));
  const text = [...rows.slice(0, go).map((r) => (r.startsWith("HO,") || r.startsWith("KO,") ? cell(r, 6, add) : r)), ...unit, cell(rows[go], 3, add), ...rows.slice(go + 1)].join("\r\n");
  const k = EXTRA.kisaimore;
  const file = extraFile(k);
  const dropped = { ...file, receipts: file.receipts.map((r) => ({ ...r, comments: r.comments.filter((c) => c.code !== k.dropComment) })) };
  if (dropped.receipts[0].comments.length !== file.receipts[0].comments.length - 1) throw new Error(`外す記載が 1 件に決まらない: ${k.dropComment}`);
  return { taishogai: encodeUke(text), kisaimore: writeUke(dropped) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = generate();
  for (const [payer, file] of Object.entries(UKE_FILES)) {
    writeFileSync(path.join(root, file), out[payer as keyof typeof UKE_FILES]);
    console.log(`書き出し: ${file}`);
  }
  const extra = generateExtra();
  for (const key of ["taishogai", "kisaimore"] as const) {
    writeFileSync(path.join(root, EXTRA[key].file), extra[key]);
    console.log(`書き出し: ${EXTRA[key].file}`);
  }
}
