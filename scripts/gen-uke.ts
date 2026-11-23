// 合成 UKE 2 本を fixtures/uke/ に書き出す（spec FR-05）。`npx tsx scripts/gen-uke.ts`
// 入力は fixtures/cases/K1〜K7.json と fixtures/uke/patients.json。出力は入力だけで決まる。
// 見本の 2 本とは別に、アップロードで試すための合成の UKE も 3 本書き出す（design.md §11-11・§11-12。設定は fixtures/uke/extra.json、値は EM 5-1 の表）：
// 点検の対象外の行を含むもの（taishogai.UKE）、必須の記載を 1 つ欠いたもの（kisaimore.UKE）、改定前の診療年月のもの（kaiteimae.UKE）。
// 取り忘れの症例 K8〜K11 の合成の UKE（torikawasure.UKE。設定は fixtures/uke/kb.json。design.md §15-10 の 3）も、同じ作り方で書き出す。
// 受け入れの症例 K12・K13 の合成の UKE（kozoka.UKE。設定は fixtures/uke/kb-structured.json。design.md §16-10 の E-13）も、同じ作り方で書き出す。
// もう 1 本、実在の請求と同じ形（医薬品・特定器材・症状詳記などを含む）を読めることを確かめるための合成の UKE（jitsurei.UKE。設定は fixtures/uke/jitsurei.json）
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monthFrom, period } from "../src/demo/period";
import { resolveRevision, revisionById } from "../src/engine/revisions";
import type { ClaimContext, Payer } from "../src/engine/types";
import { buildUkeFiles, type UkeSources } from "../src/uke/cases";
import type { UkeFile, UkePatient } from "../src/uke/types";
import { diseaseCodeOf, UNCODED_DISEASE } from "../src/uke/diseases";
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
  kaiteimae: { file: string; base: string; patientNo: string; patient: ExtraPatient; monthsBack: number; pointsOf: string; drop: string[] };
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
 * kisaimore：もとの症例から、必須の記載のコメントを 1 つ外す。取り込んだレセプトの点検で、記載もれが 1 件出る。
 * kaiteimae：もとの症例を、改定前の診療年月（基準月の monthsBack か月前）のレセプトにする（design.md §11-12）。コードは基準月の版のもの（EM §2-9 で、令和6年度版でも同じと確かめた区分だけ）、
 * 点数は pointsOf の版（令和6年度の値）。drop の区分の行とコメントは入れず、傷病名は未コード化で書く。診療年月に版がないので、取り込むと月末の点検には並ばず、版を選んで試算する
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
  // 足した単位の日は、受診日等（JD。1 日の情報は項目 3）にも書く。もとの症例で受診のない日なら、診療実日数（HO・KO の項目 5）も 1 日増やす
  const newDay = rows.find((r) => r.startsWith("JD,"))!.split(",")[1 + u.day] === "" ? 1 : 0;
  const head = rows.slice(0, go).map((r) =>
    r.startsWith("HO,") || r.startsWith("KO,") ? cell(cell(r, 6, add), 5, (v) => String(Number(v) + newDay)) : r.startsWith("JD,") ? cell(r, 2 + u.day, () => "1") : r,
  );
  const text = [...head, ...unit, cell(rows[go], 3, add), ...rows.slice(go + 1)].join("\r\n");
  const k = EXTRA.kisaimore;
  const file = extraFile(k);
  const dropped = { ...file, receipts: file.receipts.map((r) => ({ ...r, comments: r.comments.filter((c) => c.code !== k.dropComment) })) };
  if (dropped.receipts[0].comments.length !== file.receipts[0].comments.length - 1) throw new Error(`外す記載が 1 件に決まらない: ${k.dropComment}`);
  return { taishogai: encodeUke(text), kisaimore: writeUke(dropped), kaiteimae: generateOld() };
}

function generateOld(): Buffer {
  const o = EXTRA.kaiteimae;
  const old = revisionById(o.pointsOf);
  if (!old) throw new Error(`点数を取る版がない: ${o.pointsOf}`);
  const file = extraFile(o);
  const yearMonth = monthFrom(-o.monthsBack);
  /** 基準月の日付（YYYY-MM-DD）を、同じ日のまま改定前の診療年月に移す */
  const moved = (date: string) => {
    if (!date.startsWith(`${period.yearMonth}-`)) throw new Error(`基準月の外の日付: ${date}`);
    return `${yearMonth}${date.slice(7)}`;
  };
  /** 傷病名の診療開始日（YYYYMMDD）を、同じ月数だけ前にずらす */
  const earlier = (ymd: string) => {
    const i = Number(ymd.slice(0, 4)) * 12 + Number(ymd.slice(4, 6)) - 1 - o.monthsBack;
    return `${Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, "0")}${ymd.slice(6)}`;
  };
  const receipts = file.receipts.map((r) => ({
    ...r,
    yearMonth,
    patient: { ...r.patient, diseases: r.patient.diseases.map((d) => ({ ...d, code: UNCODED_DISEASE, start: earlier(d.start) })) },
    lines: r.lines.filter((l) => !o.drop.includes(l.kubun)).map((l) => ({ ...l, dates: l.dates.map(moved) })),
    comments: [],
  }));
  // 書くときの版：コードの表・診療識別は基準月の版、点数表は pointsOf の版。pointsOf の版にない区分の行が残っていれば、書き出しが例外にする
  const rev = { ...resolveRevision(period.yearMonth), points: old.points };
  return writeUke({ ...file, billingMonth: monthFrom(1 - o.monthsBack), receipts }, () => rev);
}

type JitsureiRow = {
  rec: "SI" | "IY" | "TO" | "CO";
  shikibetsu?: string;
  code: string;
  quantity?: string;
  points?: number;
  minus?: true;
  days?: Record<string, number>;
  comments?: [string, string][];
  price?: string;
  product?: string;
  text?: string;
};
type Jitsurei = {
  file: string;
  payer: Payer;
  receipts: {
    patientNo: string;
    receiptType: string;
    patient: Pick<UkePatient, "name" | "sex" | "birth" | "insurer">;
    diseases: UkePatient["diseases"];
    visits: Record<string, number>;
    rows: JitsureiRow[];
    notes: { kind: string; text: string }[];
  }[];
};
export const JITSUREI = JSON.parse(readFileSync(path.join(root, "fixtures", "uke", "jitsurei.json"), "utf8")) as Jitsurei;
/** 取り忘れの症例 K8〜K11 の合成の UKE の設定（design.md §15-10 の 3。形は jitsurei.json と同じ） */
export const TORIKAWASURE = JSON.parse(readFileSync(path.join(root, "fixtures", "uke", "kb.json"), "utf8")) as Jitsurei;
/** 受け入れの症例 K12・K13 の合成の UKE の設定（design.md §16-10 の E-13。形は jitsurei.json と同じ） */
export const KOZOKA = JSON.parse(readFileSync(path.join(root, "fixtures", "uke", "kb-structured.json"), "utf8")) as Jitsurei;

/**
 * 実在の請求と同じ形の、検証用の合成の UKE（設定は fixtures/uke/jitsurei.json。EM 5-1 の表）。外来 3 件と在宅 1 件を 1 つのファイルにする。
 * 同じ形の設定（cfg）で、取り忘れの症例 K8〜K11 の UKE（fixtures/uke/kb.json → torikawasure.UKE）も書く。
 * formatUke は診療行為の行しか書かないので、ここでレコードを組む：医薬品（IY）・特定器材（TO）・コメント（CO）・症状詳記（SJ）と、資格確認（SN）・受診日等（JD）・窓口負担額（MF）を含む。
 * 回数は算定日情報の合計、HO の合計点数は「1 回分の点数 × 回数」の合計（minus の行は引く）、診療実日数は受診等区分が 1 の日の数。医療機関は同梱の症例と同じ（東京都）
 */
export function generateJitsurei(cfg: Jitsurei = JITSUREI): Buffer {
  const { src } = loadSources();
  // 値が undefined の列は空のまま（TO だけの列を条件つきで広げるため、型の上で undefined があり得る）
  const rec = (n: number, cols: Record<number, string | number | undefined>) => {
    const out: string[] = Array.from({ length: n }, () => "");
    for (const [k, v] of Object.entries(cols)) if (v !== undefined) out[Number(k) - 1] = String(v);
    return out.join(",");
  };
  /** 「日 → 値」を、1 日の情報が first 列目のレコードの列にする */
  const dayCols = (first: number, days: Record<string, number>) => Object.fromEntries(Object.entries(days).map(([d, n]) => [first + Number(d) - 1, n]));
  const count = (x: JitsureiRow) => Object.values(x.days ?? {}).reduce((s, n) => s + n, 0);
  const ym = (yearMonth: string) => yearMonth.replace("-", "");
  const rows = [rec(10, { 1: "IR", 2: cfg.payer === "支払基金" ? 1 : 2, 3: "13", 4: 1, 5: src.clinic.code, 7: src.clinic.name, 8: ym(BILLING_MONTH), 9: "00", 10: src.clinic.phone })];
  let grand = 0;
  cfg.receipts.forEach((r, i) => {
    const p = r.patient;
    const total = r.rows.reduce((s, x) => s + (x.points === undefined ? 0 : (x.minus ? -1 : 1) * x.points * count(x)), 0);
    grand += total;
    rows.push(rec(38, { 1: "RE", 2: i + 1, 3: r.receiptType, 4: ym(period.yearMonth), 5: p.name, 6: p.sex, 7: p.birth, 14: r.patientNo }));
    rows.push(rec(15, { 1: "HO", 2: p.insurer.number.padStart(8, " "), 3: p.insurer.symbol, 4: p.insurer.no, 5: Object.values(r.visits).filter((v) => v === 1).length, 6: total }));
    // 資格確認・受診日等・窓口負担額は、見本と同じ合成の設定（枝番は後期高齢者医療では書かない）
    rows.push(rec(9, { 1: "SN", 2: 1, 3: "01", 7: p.insurer.number.startsWith("39") ? "" : "01" }));
    rows.push(rec(33, { 1: "JD", 2: 1, ...dayCols(3, r.visits) }));
    rows.push(rec(33, { 1: "MF", 2: "00" }));
    for (const d of r.diseases) {
      const code = d.code ?? diseaseCodeOf(d.name);
      rows.push(rec(8, { 1: "SY", 2: code, 3: d.start, 4: d.outcome ?? 1, 5: (d.modifiers ?? []).join(""), 6: code === UNCODED_DISEASE ? d.name : "", 7: d.main ? "01" : "", 8: d.note ?? "" }));
    }
    for (const x of r.rows) {
      if (x.rec === "CO") {
        rows.push(rec(5, { 1: "CO", 2: x.shikibetsu ?? "", 3: 1, 4: x.code, 5: x.text ?? "" }));
        continue;
      }
      // TO は、単価が項目 9、商品名及び規格又はサイズが項目 11、コメント欄が 12 から、算定日情報が 18 から。SI・IY は、コメント欄が 8 から、算定日情報が 14 から
      const [comment, day] = x.rec === "TO" ? [12, 18] : [8, 14];
      rows.push(
        rec(x.rec === "TO" ? 48 : 44, {
          1: x.rec,
          2: x.shikibetsu ?? "",
          3: 1,
          4: x.code,
          5: x.quantity ?? "",
          6: x.points ?? "",
          7: count(x),
          ...(x.rec === "TO" ? { 9: x.price ?? "", 11: x.product ?? "" } : {}),
          ...Object.fromEntries((x.comments ?? []).flatMap(([c, t], n) => [[comment + n * 2, c], [comment + n * 2 + 1, t]])),
          ...dayCols(day, x.days ?? {}),
        }),
      );
    }
    for (const n of r.notes) rows.push(rec(3, { 1: "SJ", 2: n.kind, 3: n.text }));
  });
  rows.push(rec(4, { 1: "GO", 2: cfg.receipts.length, 3: grand, 4: "99" }));
  return encodeUke(`${rows.join("\r\n")}\r\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = generate();
  for (const [payer, file] of Object.entries(UKE_FILES)) {
    writeFileSync(path.join(root, file), out[payer as keyof typeof UKE_FILES]);
    console.log(`書き出し: ${file}`);
  }
  const extra = generateExtra();
  for (const key of ["taishogai", "kisaimore", "kaiteimae"] as const) {
    writeFileSync(path.join(root, EXTRA[key].file), extra[key]);
    console.log(`書き出し: ${EXTRA[key].file}`);
  }
  writeFileSync(path.join(root, JITSUREI.file), generateJitsurei(JITSUREI));
  console.log(`書き出し: ${JITSUREI.file}`);
  writeFileSync(path.join(root, TORIKAWASURE.file), generateJitsurei(TORIKAWASURE));
  console.log(`書き出し: ${TORIKAWASURE.file}`);
  writeFileSync(path.join(root, KOZOKA.file), generateJitsurei(KOZOKA));
  console.log(`書き出し: ${KOZOKA.file}`);
}
