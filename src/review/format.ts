// 増減点連絡書 CSV（RIzogn…csv）と返戻内訳書 CSV（RIhenr…csv）の読み取り（spec FR-202 の I-1。design/iji-context/plan-i1.md）。
// 項目の並びとファイル名の規則は sources/research/zogen-henrei-format.md §1〜§3（資料1 の項目表）のとおり。そこにない項目は作らない。
// 未確認の点は、未確認のまま扱う：
// - 文字コード：UTF-8 として正しく読めればそれで、読めなければシフト JIS で読む
// - ヘッダ（種別 1）の項目の位置：明細と同じく項番 2 を診療月として読む（ほかの項目は読まない）
// - 「請求内容」「補正・査定後内容」の文字列の書式：中を分解せず、そのまま持つ
// - 返戻レセプト（RECEIPTC.HEN／SAH）・再審査等支払調整額通知票は読まない
import type { Payer } from "../engine/types";

export class ReviewError extends Error {
  constructor(
    readonly line: number | null,
    reason: string,
  ) {
    super(line === null ? reason : `${line} 行目：${reason}`);
  }
}

export type ReviewKind = "zogen" | "henrei";
export const KIND_LABEL: Record<ReviewKind, string> = { zogen: "増減点連絡書", henrei: "返戻内訳書" };

/** ファイル名から読むこと（資料1 p.13–15）。processedMonth は処理年月（YYYY-MM） */
export type ReviewFileName = { kind: ReviewKind; paper: boolean; payer: Payer; prefectureCode: string; clinicCode: string; processedMonth: string };

/**
 * 明細 1 行（種別 3〜5）。前の行の値を引き継ぐ省略規則を当てたあとの値。
 * receiptSeq はファイルの中のレセプトの通し番号（種別 3 の行で 1 つ進む。レセプトの件数を数えるのに使う）。
 * yearMonth は明細の診療年月（月遅れのときだけ。YYYY-MM）。insurers は保険者番号・公費負担者番号の欄（空は除く）。
 * points は増減点数（返戻内訳書は請求点数）、amount は金額（負担金額の増減。増減点連絡書の `-¥7000` の形）。
 * jiyu は事由（増減点連絡書は記号を 1 字ずつ、返戻内訳書は事由コード 1 つ）、jiyuText は返戻の事由の文字列。
 * seikyu・satei は請求内容・補正・査定後内容の文字列（分解しない）
 */
export type ReviewRow = {
  line: number;
  recordType: 3 | 4 | 5;
  receiptSeq: number;
  yearMonth: string | null;
  receiptNo: string;
  uketsuke: string;
  insurers: string[];
  name: string;
  karte: string;
  kasho1: string;
  kasho2: string;
  points: number | null;
  amount: number | null;
  jiyu: string[];
  jiyuText: string;
  seikyu: string;
  satei: string;
};

export type ReviewCsv = { file: ReviewFileName; headerMonth: string | null; rows: ReviewRow[] };

/** 取り込む CSV の大きさの上限（増減点連絡書は 1 か月分で数百行の見込み。余裕を持たせる） */
export const REVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** 和暦の年月（GYYMM。G は元号：4 平成・5 令和）を YYYY-MM にする。形が違えば null */
export function eraMonth(v: string): string | null {
  const m = /^([45])(\d{2})(\d{2})$/.exec(v);
  if (!m) return null;
  const year = (m[1] === "5" ? 2018 : 1988) + Number(m[2]);
  const month = Number(m[3]);
  if (month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * ファイル名（`RIzogn` / `RIhenr` + 審査支払機関 1 + 都道府県 2 + 点数表 1 + 医療機関コード 7 + 処理年月 GYYMM + `.csv`）を読む。
 * `MI` で始まるものは紙レセプト分。末尾に TEST の付く確認試験の分は取り込まない。医科（点数表 1）だけ
 */
export function readFileName(name: string): ReviewFileName {
  const base = name.split(/[\\/]/).pop() ?? "";
  if (/TEST\.csv$/i.test(base)) throw new ReviewError(null, "確認試験のファイル（名前の末尾が TEST）は取り込みません");
  const m = /^(RI|MI)(zogn|henr)([12])(\d{2})(\d)(\d{7})(\d{5})\.csv$/i.exec(base);
  if (!m) throw new ReviewError(null, "ファイル名が増減点連絡書（RIzogn…csv）か返戻内訳書（RIhenr…csv）の形ではありません。審査支払機関と処理年月をファイル名から読むので、ダウンロードしたときの名前のまま選んでください");
  if (m[5] !== "1") throw new ReviewError(null, "医科（点数表 1）のファイルではありません");
  const processedMonth = eraMonth(m[7]);
  if (!processedMonth) throw new ReviewError(null, "ファイル名の処理年月が読めません");
  return { kind: m[2].toLowerCase() === "zogn" ? "zogen" : "henrei", paper: m[1].toUpperCase() === "MI", payer: m[3] === "1" ? "支払基金" : "国保連", prefectureCode: m[4], clinicCode: m[6], processedMonth };
}

/** UTF-8 として正しく読めればそれで、読めなければシフト JIS で読む。末尾の EOF（0x1A）と先頭の BOM は外す */
export function decodeCsv(buf: Uint8Array): string {
  const body = buf.length > 0 && buf[buf.length - 1] === 0x1a ? buf.subarray(0, buf.length - 1) : buf;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body).replace(/^﻿/, "");
  } catch {
    try {
      return new TextDecoder("shift_jis", { fatal: true }).decode(body);
    } catch {
      throw new ReviewError(null, "文字コードが UTF-8 でもシフト JIS でもありません");
    }
  }
}

/** CSV を行と項目に分ける。引用符（"）で囲んだ項目と、その中の "" を読む（引用符を使うかは未確認なので、どちらでも読む）。改行は CRLF・LF のどちらも */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 増減点数・金額の欄（`-216`、`+216`、`-¥7000`）。全角は半角にしてから読む */
function signed(v: string): { points: number | null; amount: number | null } {
  const m = /^([+-]?)([¥\\]?)(\d+)$/.exec(v.normalize("NFKC").trim());
  if (!m) return { points: null, amount: null };
  const n = Number(m[3]) * (m[1] === "-" ? -1 : 1);
  return m[2] ? { points: null, amount: n } : { points: n, amount: null };
}

/** 項番 n（1 起算）の値。項目が足りない行は空として読む */
const at = (c: string[], n: number): string => (c[n - 1] ?? "").trim();

/**
 * 増減点連絡書の明細（資料1 p.43–48。項番 1〜30）。省略の規則（p.48 注）：前の行とレセプト番号が同じなら項番 2〜19 を省略、
 * 前の行と点数・回数が同じなら項番 20〜21 を省略。読むときは前の行の値を引き継ぐ
 */
function zogenRows(recs: { line: number; c: string[] }[]): ReviewRow[] {
  const out: ReviewRow[] = [];
  let prev: string[] | null = null;
  let seq = 0;
  for (const { line, c } of recs) {
    const type = Number(at(c, 1)) as 3 | 4 | 5;
    const v = Array.from({ length: 30 }, (_, i) => at(c, i + 1));
    if (type === 3) seq++;
    else if (prev === null) throw new ReviewError(line, "明細の 1 行目（種別 3）より前に続きの行がある");
    // 2 行目以降でレセプト番号が空なら、項番 2〜19 は前の行と同じ
    if (type !== 3 && prev && v[2] === "") for (let i = 1; i <= 18; i++) if (v[i] === "") v[i] = prev[i];
    // 箇所（項番 20・21）が両方とも空なら、前の行と同じ（合計の行からは引き継がない）
    if (type === 4 && prev && v[19] === "" && v[20] === "" && Number(prev[0]) !== 5) [v[19], v[20]] = [prev[19], prev[20]];
    const { points, amount } = signed(v[22]);
    out.push({
      line,
      recordType: type,
      receiptSeq: seq,
      yearMonth: v[1] ? eraMonth(v[1]) : null,
      receiptNo: v[2],
      uketsuke: v[3],
      insurers: v.slice(7, 13).filter((x) => x !== ""),
      name: v[17],
      karte: v[18],
      kasho1: v[19].normalize("NFKC"),
      kasho2: v[20],
      points,
      amount,
      jiyu: [...v[23].normalize("NFKC")].filter((x) => /[A-Z]/.test(x)),
      jiyuText: "",
      seikyu: v[25],
      satei: v[27],
    });
    prev = v;
  }
  return out;
}

/** 診療年月の欄（返戻内訳書は電子請求分が YYMM〔令和として読む〕、紙請求分が GYYMM） */
const henreiMonth = (v: string): string | null => (v.length === 4 ? eraMonth(`5${v}`) : eraMonth(v));

/** 返戻内訳書の明細（資料1 p.49–54。項番 1〜20）。省略の規則（p.54 注1）：前の行と受付番号が同じなら項番 2・3・5・7・18〜20 を省略 */
function henreiRows(recs: { line: number; c: string[] }[]): ReviewRow[] {
  const out: ReviewRow[] = [];
  let prev: string[] | null = null;
  let seq = 0;
  for (const { line, c } of recs) {
    const type = Number(at(c, 1)) as 3 | 4;
    const v = Array.from({ length: 20 }, (_, i) => at(c, i + 1));
    if (type === 3) seq++;
    else if (prev === null) throw new ReviewError(line, "明細の 1 行目（種別 3）より前に続きの行がある");
    if (type === 4 && prev && v[2] === "") for (const i of [1, 2, 4, 6, 17, 18, 19]) if (v[i] === "") v[i] = prev[i];
    const p = signed(v[8]);
    out.push({
      line,
      recordType: type,
      receiptSeq: seq,
      yearMonth: v[1] ? henreiMonth(v[1]) : null,
      receiptNo: "",
      uketsuke: v[2],
      insurers: v[3] ? [v[3]] : [],
      name: v[6],
      karte: v[17],
      kasho1: "",
      kasho2: "",
      points: p.points,
      amount: null,
      jiyu: v[15] ? [v[15]] : [],
      jiyuText: v[16],
      seikyu: "",
      satei: "",
    });
    prev = v;
  }
  return out;
}

/** 増減点連絡書・返戻内訳書の CSV を読む。種別 1（ヘッダ）は先頭に 1 つ、2（タイトル）・6（集計）は読み飛ばす。知らない種別の行があれば断る */
export function readReviewCsv(fileName: string, buf: Uint8Array): ReviewCsv {
  if (buf.length > REVIEW_MAX_BYTES) throw new ReviewError(null, "ファイルが大きすぎます");
  const file = readFileName(fileName);
  const rows = splitCsv(decodeCsv(buf))
    .map((c, i) => ({ line: i + 1, c }))
    .filter((r) => r.c.some((x) => x.trim() !== ""));
  if (rows.length === 0 || at(rows[0].c, 1) !== "1") throw new ReviewError(1, "先頭がヘッダ（レコード種別 1）ではありません");
  const allowed = file.kind === "zogen" ? ["2", "3", "4", "5", "6"] : ["2", "3", "4"];
  const details: { line: number; c: string[] }[] = [];
  for (const r of rows.slice(1)) {
    const type = at(r.c, 1);
    if (type === "1") throw new ReviewError(r.line, "ヘッダ（レコード種別 1）が 2 つある");
    if (!allowed.includes(type)) throw new ReviewError(r.line, "知らないレコード種別");
    if (type === "3" || type === "4" || type === "5") details.push(r);
  }
  const headerMonth = eraMonth(at(rows[0].c, 2));
  return { file, headerMonth, rows: file.kind === "zogen" ? zogenRows(details) : henreiRows(details) };
}
