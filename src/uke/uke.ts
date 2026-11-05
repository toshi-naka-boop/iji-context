// 合成 UKE の書き出しと読み込み（F4、spec FR-05・FR-06）
// 形式：Shift_JIS・CSV（引用符なし）・CRLF・末尾 EOF(0x1A)。レコード順は IR→(RE→HO/KO→SY→SI/CO)×n→GO
// 列は記録条件仕様（医科用）令和6年6月版の主要列だけを埋め、ほかは空にする（EM 12-1、report-A 項目12 の列番号）
// 診療行為コードは架空（codes-fictional.ts）。実在のマスターとは無関係
import iconv from "iconv-lite";
import { fictionalCode, kubunOfCode } from "../engine/codes-fictional";
import { pointsOf } from "../engine/points-2024";
import type { ClaimLine, Payer } from "../engine/types";
import type { UkeFile, UkeReceipt } from "./types";

const EOF = 0x1a;
const PREF_CODE: Record<string, string> = { 東京都: "13" };

/** 診療識別（別表20）。区分の先頭から決める */
function shinryoShikibetsu(kubun: string): string {
  if (/^C/.test(kubun)) return "14"; // 在宅
  if (/^F400/.test(kubun)) return "25"; // 処方箋料
  if (/^D/.test(kubun)) return "60"; // 検査
  return "80"; // その他（ベースアップ評価料など）
}

/** 負担区分（別表21）：公費なしは 1（医保単独）、公費 1 種は 2（医保＋公費①） */
const futanKubun = (kohiCount: number): string => (kohiCount === 0 ? "1" : "2");

const ymd = (date: string) => date.replaceAll("-", "");
const ym = (yearMonth: string) => yearMonth.replace("-", "");
const fromYm = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}`;

/** 列数をそろえたレコード（1 起算の列番号→値） */
function record(n: number, cols: Record<number, string | number>): string {
  const out: string[] = Array.from({ length: n }, () => "");
  for (const [k, v] of Object.entries(cols)) {
    const i = Number(k) - 1;
    if (i < 0 || i >= n) throw new Error(`列番号が範囲外: ${k}/${n}`);
    const s = String(v);
    if (/[,\r\n]/.test(s)) throw new Error(`区切り文字を含む値: ${s}`);
    out[i] = s;
  }
  return out.join(",");
}

/** その行の点数（1 回分）×回数 */
function linePoints(l: ClaimLine): number {
  const p = pointsOf(l.kubun);
  if (p === null) throw new Error(`点数未収載の区分は UKE に書けない: ${l.kubun}`);
  return p * l.count;
}

/** 算定日情報（1〜31 日の回数） */
function dayCounts(l: ClaimLine, yearMonth: string): string[] {
  const days = Array.from({ length: 31 }, () => "");
  for (const d of l.dates) {
    if (!d.startsWith(`${yearMonth}-`)) throw new Error(`診療年月の外の日付: ${d}`);
    const i = Number(d.slice(8, 10)) - 1;
    days[i] = String(Number(days[i] || 0) + 1);
  }
  const sum = days.reduce((s, v) => s + Number(v || 0), 0);
  // 算定日情報の合計＝回数（report-A 項目12）。1 日に複数回算定する区分は dates に同じ日を重ねる
  if (sum !== l.count) throw new Error(`算定日の合計 ${sum} と回数 ${l.count} が合わない: ${l.kubun}`);
  return days;
}

function receiptTotal(r: UkeReceipt): number {
  return r.lines.reduce((s, l) => s + linePoints(l), 0);
}

function realDays(r: UkeReceipt): number {
  return new Set(r.lines.flatMap((l) => l.dates)).size;
}

/** UKE の文字列（CRLF 区切り、EOF なし） */
export function formatUke(file: UkeFile): string {
  const pref = PREF_CODE[file.prefecture];
  if (!pref) throw new Error(`都道府県コード未登録: ${file.prefecture}`);
  const rows: string[] = [];
  rows.push(
    record(10, {
      1: "IR",
      2: file.payer === "支払基金" ? "1" : "2",
      3: pref,
      4: "1",
      5: file.clinic.code,
      7: file.clinic.name,
      8: ym(file.billingMonth),
      9: "00",
      10: file.clinic.phone,
    }),
  );
  file.receipts.forEach((r, idx) => {
    const p = r.patient;
    const total = receiptTotal(r);
    const days = realDays(r);
    // RE：13 列目（カルテ番号等）に請求 id を入れる
    rows.push(record(38, { 1: "RE", 2: idx + 1, 3: p.receiptType, 4: ym(r.yearMonth), 5: p.name, 6: p.sex, 7: p.birth, 13: r.claimId }));
    rows.push(record(15, { 1: "HO", 2: p.insurer.number, 3: p.insurer.symbol, 4: p.insurer.no, 5: days, 6: total }));
    for (const k of p.kohi) rows.push(record(12, { 1: "KO", 2: k.payerNo, 3: k.recipientNo, 5: days, 6: total }));
    p.diseases.forEach((d) => {
      rows.push(record(8, { 1: "SY", 2: "0000999", 3: d.start, 4: d.outcome ?? 1, 6: d.name, 7: d.main ? "01" : "" }));
    });
    for (const l of r.lines) {
      const cols: Record<number, string | number> = {
        1: "SI",
        2: shinryoShikibetsu(l.kubun),
        3: futanKubun(p.kohi.length),
        4: fictionalCode(l.kubun),
        6: pointsOf(l.kubun) ?? "",
        7: l.count,
      };
      dayCounts(l, r.yearMonth).forEach((v, i) => {
        if (v) cols[14 + i] = v;
      });
      rows.push(record(44, cols));
      for (const c of r.comments.filter((c) => c.kubun === l.kubun)) {
        rows.push(record(5, { 1: "CO", 2: shinryoShikibetsu(l.kubun), 3: futanKubun(p.kohi.length), 4: c.code }));
      }
    }
  });
  rows.push(record(4, { 1: "GO", 2: file.receipts.length, 3: file.receipts.reduce((s, r) => s + receiptTotal(r), 0), 4: "99" }));
  return `${rows.join("\r\n")}\r\n`;
}

/** UKE のバイト列（Shift_JIS、末尾 EOF） */
export function writeUke(file: UkeFile): Buffer {
  return Buffer.concat([iconv.encode(formatUke(file), "Shift_JIS"), Buffer.from([EOF])]);
}

/** UKE のバイト列を読む。形式の誤り（EOF・CRLF・レコード順・合計）は例外にする */
export function parseUke(buf: Buffer): UkeFile {
  if (buf.length === 0 || buf[buf.length - 1] !== EOF) throw new Error("末尾に EOF(0x1A) がない");
  const text = new TextDecoder("shift_jis", { fatal: true }).decode(buf.subarray(0, buf.length - 1));
  if (!text.endsWith("\r\n")) throw new Error("最後のレコードが CRLF で終わっていない");
  const lines = text.slice(0, -2).split("\r\n");
  if (lines.some((l) => l.includes("\n") || l.includes("\r"))) throw new Error("CRLF 以外の改行がある");
  const recs = lines.map((l) => l.split(","));

  const ir = recs[0];
  if (ir?.[0] !== "IR") throw new Error("先頭が IR レコードでない");
  const go = recs[recs.length - 1];
  if (go?.[0] !== "GO") throw new Error("末尾が GO レコードでない");
  const pref = Object.entries(PREF_CODE).find(([, c]) => c === ir[2])?.[0];
  if (!pref) throw new Error(`未登録の都道府県コード: ${ir[2]}`);
  const payer: Payer = ir[1] === "1" ? "支払基金" : ir[1] === "2" ? "国保連" : (() => { throw new Error(`審査支払機関コードが不正: ${ir[1]}`); })();

  const receipts: UkeReceipt[] = [];
  let cur: UkeReceipt | null = null;
  let stage = 0; // 0: RE の直後 1: HO/KO 2: SY 3: SI/CO
  let lastKubun: string | null = null;
  for (const c of recs.slice(1, -1)) {
    const kind = c[0];
    if (kind === "RE") {
      cur = {
        claimId: c[12],
        yearMonth: fromYm(c[3]),
        patient: { name: c[4], sex: Number(c[5]) as 1 | 2, birth: c[6], receiptType: c[2], insurer: { number: "", symbol: "", no: "" }, kohi: [], diseases: [] },
        lines: [],
        comments: [],
      };
      receipts.push(cur);
      stage = 0;
      lastKubun = null;
      continue;
    }
    if (!cur) throw new Error(`RE より前に ${kind} がある`);
    if (kind === "HO" || kind === "KO") {
      if (stage > 1) throw new Error(`${kind} の位置が不正（SY・SI の後）`);
      stage = 1;
      if (kind === "HO") cur.patient.insurer = { number: c[1], symbol: c[2], no: c[3] };
      else cur.patient.kohi.push({ payerNo: c[1], recipientNo: c[2] });
    } else if (kind === "SY") {
      if (stage > 2) throw new Error("SY の位置が不正（SI の後）");
      stage = 2;
      cur.patient.diseases.push({
        name: c[5],
        start: c[2],
        ...(c[6] === "01" ? { main: true } : {}),
        ...(c[3] !== "1" ? { outcome: Number(c[3]) as 2 | 3 | 4 } : {}),
      });
    } else if (kind === "SI") {
      stage = 3;
      const kubun = kubunOfCode(c[3]);
      const count = Number(c[6]);
      const dates: string[] = [];
      for (let d = 1; d <= 31; d++) {
        const n = Number(c[12 + d] || 0);
        for (let j = 0; j < n; j++) dates.push(`${cur.yearMonth}-${String(d).padStart(2, "0")}`);
      }
      if (dates.length !== count) throw new Error(`算定日の合計 ${dates.length} と回数 ${count} が合わない: ${kubun}`);
      cur.lines.push({ kubun, count, dates });
      lastKubun = kubun;
    } else if (kind === "CO") {
      if (!lastKubun) throw new Error("CO の前に SI がない");
      cur.comments.push({ kubun: lastKubun, code: c[3] });
    } else {
      throw new Error(`未対応のレコード: ${kind}`);
    }
  }
  const total = receipts.reduce((s, r) => s + receiptTotal(r), 0);
  if (Number(go[1]) !== receipts.length) throw new Error(`GO の総件数 ${go[1]} とレセプト数 ${receipts.length} が合わない`);
  if (Number(go[2]) !== total) throw new Error(`GO の総合計点数 ${go[2]} と計算 ${total} が合わない`);
  return {
    payer,
    prefecture: pref,
    clinic: { code: ir[4], name: ir[6], phone: ir[9] },
    billingMonth: fromYm(ir[7]),
    receipts,
  };
}
