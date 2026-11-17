// 合成 UKE の書き出しと読み込み（F4、spec FR-05・FR-06）
// 形式：Shift_JIS・CSV（引用符なし）・CRLF・末尾 EOF(0x1A)。レコード順は IR→(RE→HO/KO→SY→SI/CO)×n→GO
// 列は記録条件仕様（医科用）令和6年6月版の主要列だけを埋め、ほかは空にする（EM 12-1、report-A 項目12 の列番号）
// 診療行為コードは架空（codes-fictional.ts）。実在のマスターとは無関係
import iconv from "iconv-lite";
import { fictionalCode, isFictionalCode, kubunOfCode } from "../engine/codes-fictional";
import { hasRevision, pointsOf, resolveRevision } from "../engine/revisions";
import type { Revision } from "../engine/revisions/types";
import type { ClaimLine, Payer } from "../engine/types";
import { UKE_CLAIM_ID, UKE_LIMITS } from "./limits";
import type { UkeFile, UkeReceipt } from "./types";

const EOF = 0x1a;
const PREF_CODE: Record<string, string> = { 東京都: "13" };
/** 未コード化傷病名のコード。傷病名はこのコードで名称だけを載せる（実在の傷病名コードは受け取らない） */
const UNCODED_DISEASE = "0000999";
/** レコードごとの列数（書き出しと同じ） */
const COLUMNS = new Map([["IR", 10], ["RE", 38], ["HO", 15], ["KO", 12], ["SY", 8], ["SI", 44], ["CO", 5], ["GO", 4]]);

/**
 * UKE として受け取れない入力。理由は定型文で、入力の値そのもの（氏名・番号・コード）は入れない（spec FR-107）。
 * line は 1 起算の行番号（ファイル全体についての理由は null）
 */
export class UkeError extends Error {
  readonly line: number | null;
  readonly reason: string;
  constructor(line: number | null, reason: string) {
    super(line === null ? reason : `${line} 行目：${reason}`);
    this.name = "UkeError";
    this.line = line;
    this.reason = reason;
  }
}

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

/** その行の点数（1 回分）×回数。点数はレセプトの診療年月の版のもの */
function linePoints(rev: Revision, l: ClaimLine): number {
  const p = pointsOf(rev, l.kubun);
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
  const rev = resolveRevision(r.yearMonth);
  return r.lines.reduce((s, l) => s + linePoints(rev, l), 0);
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
    const rev = resolveRevision(r.yearMonth);
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
        6: pointsOf(rev, l.kubun) ?? "",
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

/**
 * UKE のバイト列を読む（spec FR-106）。受け取れない入力は、行番号つきの UkeError にする（一部だけを読んで返すことはしない）。
 * 確かめること：大きさと行数の上限／Shift_JIS・CRLF・EOF／レコードの種類・列数・順／数字の項目の形と範囲／1 日の回数の上限／
 * 請求 id の文字種と重複／コードが架空コードの表にあること／診療年月に当たる版があること／算定日と回数・GO の件数と合計
 */
export function parseUke(buf: Buffer): UkeFile {
  const fail = (line: number | null, reason: string): never => {
    throw new UkeError(line, reason);
  };
  if (buf.length > UKE_LIMITS.maxBytes) fail(null, "ファイルが大きすぎる");
  if (buf.length === 0 || buf[buf.length - 1] !== EOF) fail(null, "末尾に EOF(0x1A) がない");
  let text = "";
  try {
    text = new TextDecoder("shift_jis", { fatal: true }).decode(buf.subarray(0, buf.length - 1));
  } catch {
    fail(null, "Shift_JIS として読めない");
  }
  if (!text.endsWith("\r\n")) fail(null, "最後のレコードが CRLF で終わっていない");
  const lines = text.slice(0, -2).split("\r\n");
  if (lines.length > UKE_LIMITS.maxLines) fail(null, "レコードの数が上限を超えている");
  const recs = lines.map((l, i) => {
    if (/[\r\n]/.test(l)) fail(i + 1, "CRLF 以外の改行がある");
    if (/[\u0000-\u001f\u007f]/.test(l)) fail(i + 1, "制御文字がある");
    const c = l.split(",");
    const columns = COLUMNS.get(c[0]);
    if (columns === undefined) fail(i + 1, "未対応のレコード");
    if (c.length !== columns) fail(i + 1, "列数が合わない");
    if (c.some((v) => v.length > UKE_LIMITS.maxFieldLength)) fail(i + 1, "項目が長すぎる");
    return c;
  });
  /** 数字だけの項目を整数で読む（符号・小数・指数は受け取らない） */
  const int = (v: string, line: number, what: string, min: number, max: number): number => {
    if (!/^\d{1,9}$/.test(v)) fail(line, `${what}が数字でない`);
    const n = Number(v);
    if (n < min || n > max) fail(line, `${what}が範囲の外`);
    return n;
  };
  /** YYYYMM を YYYY-MM にする */
  const month = (v: string, line: number, what: string): string => {
    if (!/^\d{4}(0[1-9]|1[0-2])$/.test(v)) fail(line, `${what}の形が違う`);
    return fromYm(v);
  };
  const digits = (v: string, line: number, what: string, pattern: RegExp): string => {
    if (!pattern.test(v)) fail(line, `${what}の形が違う`);
    return v;
  };

  const ir = recs[0];
  if (ir[0] !== "IR") fail(1, "先頭が IR レコードでない");
  const goLine = recs.length;
  const go = recs[goLine - 1];
  if (go[0] !== "GO" || goLine === 1) fail(goLine, "末尾が GO レコードでない");
  const pref = Object.entries(PREF_CODE).find(([, c]) => c === ir[2])?.[0] ?? fail(1, "未登録の都道府県コード");
  const payer: Payer = ir[1] === "1" ? "支払基金" : ir[1] === "2" ? "国保連" : fail(1, "審査支払機関コードが不正");
  const billingMonth = month(ir[7], 1, "請求年月");

  const receipts: UkeReceipt[] = [];
  const claimIds = new Set<string>();
  let cur: UkeReceipt | null = null;
  let points: Revision["points"] = {};
  let daysInMonth = 31;
  let stage = 0; // 0: RE の直後 1: HO/KO 2: SY 3: SI/CO
  let lastKubun: string | null = null;
  recs.slice(1, -1).forEach((c, i) => {
    const line = i + 2;
    const kind = c[0];
    if (kind === "IR" || kind === "GO") fail(line, `${kind} の位置が不正`);
    if (kind === "RE") {
      const yearMonth = month(c[3], line, "診療年月");
      // 該当する版がない診療年月は読まない（近い版で代用しない）
      if (!hasRevision(yearMonth)) fail(line, "診療年月に当たる版がない");
      if (!UKE_CLAIM_ID.test(c[12])) fail(line, "請求 id に使えない文字がある");
      if (claimIds.has(c[12])) fail(line, "同じ請求 id のレセプトが 2 つある");
      claimIds.add(c[12]);
      cur = {
        claimId: c[12],
        yearMonth,
        patient: {
          name: c[4],
          sex: int(c[5], line, "性別", 1, 2) as 1 | 2,
          birth: digits(c[6], line, "生年月日", /^\d{8}$/),
          receiptType: digits(c[2], line, "レセプト種別", /^\d{4}$/),
          insurer: { number: "", symbol: "", no: "" },
          kohi: [],
          diseases: [],
        },
        lines: [],
        comments: [],
      };
      receipts.push(cur);
      points = resolveRevision(yearMonth).points;
      daysInMonth = new Date(Date.UTC(Number(c[3].slice(0, 4)), Number(c[3].slice(4, 6)), 0)).getUTCDate();
      stage = 0;
      lastKubun = null;
      return;
    }
    if (!cur) return fail(line, `RE より前に ${kind} がある`);
    if (kind === "HO" || kind === "KO") {
      if (stage > 1) fail(line, `${kind} の位置が不正（SY・SI の後）`);
      stage = 1;
      // 番号の桁数・検証番号はここでは断らない（患者情報チェック P01 が指摘として返す）。実日数と点数は数字であることだけを見る
      int(c[4], line, "診療実日数", 0, 31);
      int(c[5], line, "合計点数", 0, UKE_LIMITS.maxPoints);
      if (kind === "HO") cur.patient.insurer = { number: c[1], symbol: c[2], no: c[3] };
      else cur.patient.kohi.push({ payerNo: c[1], recipientNo: c[2] });
    } else if (kind === "SY") {
      if (stage > 2) fail(line, "SY の位置が不正（SI の後）");
      stage = 2;
      if (c[1] !== UNCODED_DISEASE) fail(line, "傷病名コードは未コード化（名称だけ）のものに限る");
      const outcome = int(c[3], line, "転帰", 1, 4);
      cur.patient.diseases.push({
        name: c[5],
        start: digits(c[2], line, "診療開始日", /^\d{8}$/),
        ...(c[6] === "01" ? { main: true } : {}),
        ...(outcome !== 1 ? { outcome: outcome as 2 | 3 | 4 } : {}),
      });
    } else if (kind === "SI") {
      stage = 3;
      // 架空コードの表にないコードは読まない（実在のデータを通さない。FR-107）
      if (!isFictionalCode(c[3])) fail(line, "架空コードの表にないコード");
      const kubun = kubunOfCode(c[3]);
      // コードは表にあっても、レセプトの診療年月の版にない区分は読まない（FR-106）
      if (!Object.hasOwn(points, kubun)) fail(line, "診療年月の版にない区分のコード");
      if (c[5] !== "") int(c[5], line, "点数", 0, UKE_LIMITS.maxPoints);
      const count = int(c[6], line, "回数", 1, 31 * UKE_LIMITS.maxDailyCount);
      const dates: string[] = [];
      for (let d = 1; d <= 31; d++) {
        const v = c[12 + d];
        if (v === "") continue;
        // 1 日の回数は上限まで（大きな数で日付の並びを膨らませない）
        if (!/^\d$/.test(v) || Number(v) > UKE_LIMITS.maxDailyCount) fail(line, "1 日の回数が上限を超えている");
        if (Number(v) > 0 && d > daysInMonth) fail(line, "診療年月にない日に回数がある");
        for (let j = 0; j < Number(v); j++) dates.push(`${cur.yearMonth}-${String(d).padStart(2, "0")}`);
      }
      if (dates.length !== count) fail(line, "算定日の合計と回数が合わない");
      cur.lines.push({ kubun, count, dates });
      lastKubun = kubun;
    } else {
      // CO。コメントコードには架空コードの表がないので、形（数字 9 桁）だけを見る
      if (!lastKubun) return fail(line, "CO の前に SI がない");
      cur.comments.push({ kubun: lastKubun, code: digits(c[3], line, "コメントコード", /^\d{9}$/) });
    }
  });
  let total = 0;
  try {
    total = receipts.reduce((s, r) => s + receiptTotal(r), 0);
  } catch {
    fail(goLine, "点数のない区分があり、合計を確かめられない");
  }
  if (int(go[1], goLine, "総件数", 0, UKE_LIMITS.maxLines) !== receipts.length) fail(goLine, "GO の総件数とレセプト数が合わない");
  if (int(go[2], goLine, "総合計点数", 0, UKE_LIMITS.maxPoints * 100) !== total) fail(goLine, "GO の総合計点数と計算が合わない");
  return {
    payer,
    prefecture: pref,
    clinic: { code: ir[4], name: ir[6], phone: ir[9] },
    billingMonth,
    receipts,
  };
}
