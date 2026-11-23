// UKE の書き出しと読み込み（F4、spec FR-05・FR-06。design.md §11-14）
// 形式：Shift_JIS・CSV（引用符なし）・CRLF・末尾 EOF(0x1A)（読むときは EOF のないファイルも受け取る。parseUke の注）。レコード順は IR→(RE→HO/KO→SN→JD→MF→GR→SY→SI/IY/TO/CO→SJ)×n→GO
// 列は記録条件仕様（医科用）令和8年8月版の主要列だけを埋め、ほかは空にする（EM §2-10 表 4）
// 読み込みは、同仕様の医科のレコード 18 種（COLUMNS）を受け取る。入院のレセプト・臓器提供者のレセプト情報・知らないレコードは、そのレセプトだけを「読めない」にして、ファイルは断らない
//
// 読み込みは 2 段（design.md §11-12）：
//   parseUke  形式だけを見る。版を見ず、点数・回数の算定単位とコードのまま返す
//   mapClaim  レセプト 1 件のコードを、版の表で区分に引く。例外にせず、単位ごとに「引けた／引けない（理由）」を返す
// 引けないコードを含む単位は、断らずに点検の対象外の単位として残す（design.md §11-11）。
// readUke は取り込みの入口で、2 つを続けて行い、点数の食い違い・合計の食い違いがあればファイルごと断る。
// 診療年月に版がないレセプトは断らず、コードを区分に引かないまま残す（noRevision。点検には並べず、版を選んで試算する。§11-12）。
// readStoredUke は保存済みのファイルの読み直しで、あとから表が変わって食い違うようになったレセプトを、例外にせず unreadable として返す（§11-12）
import iconv from "iconv-lite";
import { hasRevision, pointsOf, resolveRevision, REVISIONS } from "../engine/revisions";
import { bundleKubun, bundleOfCode, bundleOfKubun, codeOf, kubunOfCode } from "../engine/revisions/codes";
import type { Revision } from "../engine/revisions/types";
import type { ClaimLine, Comment, Payer } from "../engine/types";
import { diseaseCodeOf, diseaseNameOf, UNCODED_DISEASE } from "./diseases";
import { UKE_LIMITS } from "./limits";
import type { UkeClaim, UkeComment, UkeFile, UkeItem, UkeLine, UkeOther, UkeParsed, UkeReceipt, UkeUnit } from "./types";

const EOF = 0x1a;
/** 都道府県コード（別表2。01 北海道〜47 沖縄県の並び） */
const PREFECTURES = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split(" ");
const PREF_CODE: Record<string, string> = Object.fromEntries(PREFECTURES.map((p, i) => [p, String(i + 1).padStart(2, "0")]));
/**
 * レコードごとの項目数（記録条件仕様（医科用）令和8年8月版 p5〜24。書き出しと同じ）。医科の請求ファイルに現れるレコードの全部：
 * 医療機関情報 IR／レセプト共通 RE／保険者 HO／公費 KO／資格確認 SN／受診日等 JD／窓口負担額 MF／包括評価対象外理由 GR／傷病名 SY／
 * 診療行為 SI／医薬品 IY／特定器材 TO／コメント CO／症状詳記 SJ／臓器提供医療機関情報 TI／臓器提供者レセプト情報 TR／臓器提供者請求情報 TS／診療報酬請求書 GO
 */
const COLUMNS = new Map([
  ["IR", 10], ["RE", 38], ["HO", 15], ["KO", 12], ["SN", 9], ["JD", 33], ["MF", 33], ["GR", 3], ["SY", 8],
  ["SI", 44], ["IY", 44], ["TO", 48], ["CO", 5], ["SJ", 3], ["TI", 10], ["TR", 18], ["TS", 5], ["GO", 4],
]);
/** 医保（国保・後期高齢者医療を含む）に請求点数のある負担区分（別表21 で「医保」に○）。HO の合計点数に入るのは、この負担区分の単位だけ */
const INSURED_FUTAN = new Set("123EG4MNOPQVWXY9");
/**
 * 点数を減じる医薬品コード（医薬品マスター（令和8年度版）の金額種別が 7：減点 の 6 コード。薬剤料逓減・薬剤料減点など）。
 * UKE には正の数で書かれ、請求の合計からは引く（手引き 令和8年10月版 p35・p63・p69）。このコードだけで 1 つの単位になる
 */
const DEDUCTION_CODES = new Set(["630010001", "630010002", "630010004", "630010005", "630010006", "630010007"]);
/** 減じるコードだけでできた単位か（点数を請求の合計から引く単位） */
export const isDeductionUnit = (u: UkeUnit): boolean => u.items.every((it) => DEDUCTION_CODES.has(it.code));
/** 単位の請求点数（1 回分 × 回数。減じるコードの単位は負） */
const unitTotal = (u: UkeUnit): number => (isDeductionUnit(u) ? -1 : 1) * u.points * u.count;
/** UKE に書いてある点数どうしの合計：HO の合計点数と突き合わせる、医保に請求する単位の合計 */
const insuredTotal = (c: UkeClaim): number => c.units.reduce((s, u) => (INSURED_FUTAN.has(u.futan) ? s + unitTotal(u) : s), 0);
/**
 * 診療行為（SI）・医薬品（IY）・特定器材（TO）のレコードの、コメント欄（コードと文字データの 3 対）と算定日情報（1〜31 日の回数）の始まり（0 起算の添字）。
 * SI・IY はコメントが項目 8〜13・算定日が 14〜44、TO はコメントが 12〜17・算定日が 18〜48（EM §2-10 表 4 の (d)・(g)）。
 * 診療識別（項目 2）・負担区分（3）・コード（4）・数量データ／使用量（5）・点数（6）・回数（7）は 3 つとも同じ位置
 */
const ITEM_LAYOUT = { SI: { comments: 7, days: 13 }, IY: { comments: 7, days: 13 }, TO: { comments: 11, days: 17 } } as const;
/** レセプト全体へのコメントの診療識別（別表20） */
const WHOLE_RECEIPT = "01";

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

/** 負担区分（別表21）：公費なしは 1（医保単独）、公費 1 種は 2（医保＋公費①） */
const futanKubun = (kohiCount: number): string => (kohiCount === 0 ? "1" : "2");

const ym = (yearMonth: string) => yearMonth.replace("-", "");
const fromYm = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}`;

/** コメントの文字データの、全角の数字・記号を半角に寄せる（英字とかな・漢字はそのまま。design.md §11-13） */
export const normalizeCommentText = (raw: string): string => raw.replace(/[！-～]/g, (c) => (/[Ａ-Ｚａ-ｚ]/.test(c) ? c : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));

/**
 * 半角に寄せた文字データから、UKE に書くコメントを作る。数字・記号は全角で記録する（EM §2-10 表 3）ので、原文（raw）は全角に直す。
 * on は、そのコメントが付く行の区分
 */
export const commentOf = (code: string, text: string, on: string[]): Comment => ({
  code,
  text,
  raw: text.replace(/[!-~]/g, (c) => (/[A-Za-z]/.test(c) ? c : String.fromCharCode(c.charCodeAt(0) + 0xfee0))),
  on,
});

// ───────────────────────────────────────────────────────────────────────────
// 書き出し

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

/** 算定日情報（1〜31 日の回数） */
function dayCounts(l: ClaimLine, yearMonth: string): number[] {
  const days = Array.from({ length: 31 }, () => 0);
  for (const d of l.dates) {
    if (!d.startsWith(`${yearMonth}-`)) throw new Error(`診療年月の外の日付: ${d}`);
    days[Number(d.slice(8, 10)) - 1] += 1;
  }
  const sum = days.reduce((s, v) => s + v, 0);
  // 算定日情報の合計＝回数。1 日に複数回算定する区分は dates に同じ日を重ねる
  if (sum !== l.count) throw new Error(`算定日の合計 ${sum} と回数 ${l.count} が合わない: ${l.kubun}`);
  return days;
}

/** 書き出す算定単位。points は 1 回分（単位の最後の行に書く）。rows の診療識別は先頭の行にだけ書く */
type OutUnit = { kubun: string[]; rows: { code: string; quantity: string }[]; points: number; count: number; days: number[]; comments: Comment[] };

/**
 * レセプトの行を算定単位にする。行 1 つが単位 1 つ。ただし、注加算（版の codes の base）は基本の項目の単位に入れ、合算の点数を最後の行に書く。
 * 包括の検査の区分は、行の items（検査項目のコード）を 1 行ずつ並べる。きざみで算定する区分は、同じ日に重ねた回数を数量データにする
 */
function unitsOf(rev: Revision, r: UkeReceipt): OutUnit[] {
  const unitPoints = (kubun: string): number => {
    const p = pointsOf(rev, kubun);
    if (p === null) throw new Error(`点数未収載の区分は UKE に書けない: ${kubun}`);
    return p;
  };
  const sameDates = (a: ClaimLine, b: ClaimLine) => [...a.dates].sort().join() === [...b.dates].sort().join();
  const addOns = new Map<number, UkeLine[]>();
  const isAddOn = new Set<UkeLine>();
  for (const l of r.lines) {
    const base = Object.hasOwn(rev.codes, l.kubun) ? rev.codes[l.kubun].base : undefined;
    if (base === undefined) continue;
    const j = r.lines.findIndex((b) => b.kubun === base && sameDates(b, l));
    if (j < 0) throw new Error(`注加算を、基本の項目と同じ単位に書けない（同じ日の ${base} の行がない）: ${l.kubun}`);
    addOns.set(j, [...(addOns.get(j) ?? []), l]);
    isAddOn.add(l);
  }
  const units: OutUnit[] = [];
  r.lines.forEach((l, i) => {
    if (isAddOn.has(l)) return;
    const days = dayCounts(l, r.yearMonth);
    const bundle = bundleOfKubun(rev, l.kubun);
    if (bundle) {
      const items = l.items ?? [];
      const ok = new Set(items).size === items.length && items.every((c) => bundle.bundle.members.includes(c)) && items.length >= bundle.min && items.length <= bundle.max;
      if (!ok) throw new Error(`包括の検査の項目が、区分と合わない: ${l.kubun}`);
      units.push({ kubun: [l.kubun], rows: items.map((code) => ({ code, quantity: "" })), points: unitPoints(l.kubun), count: l.count, days, comments: [] });
      return;
    }
    const members = [l, ...(addOns.get(i) ?? [])];
    for (const m of members) dayCounts(m, r.yearMonth);
    if (rev.codes[l.kubun]?.quantity) {
      // 同じ日に重ねた回数が項目数（数量データ）。日によって項目数が違う行は、1 つの単位に書けない
      const perDay = [...new Set(days.filter((v) => v > 0))];
      if (perDay.length !== 1 || members.length > 1) throw new Error(`きざみで算定する区分を 1 つの単位に書けない: ${l.kubun}`);
      const dayCount = days.filter((v) => v > 0).length;
      units.push({ kubun: [l.kubun], rows: [{ code: codeOf(rev, l.kubun), quantity: String(perDay[0]) }], points: unitPoints(l.kubun) * perDay[0], count: dayCount, days: days.map((v) => (v > 0 ? 1 : 0)), comments: [] });
      return;
    }
    units.push({
      kubun: members.map((m) => m.kubun),
      rows: members.map((m) => ({ code: codeOf(rev, m.kubun, r.facilityResident), quantity: "" })),
      points: members.reduce((s, m) => s + unitPoints(m.kubun), 0),
      count: l.count,
      days,
      comments: [],
    });
  });
  for (const c of r.comments) {
    if (c.on.length === 0) continue;
    const u = units.find((x) => c.on.every((k) => x.kubun.includes(k)));
    if (!u) throw new Error(`コメントの付く区分の行がない: ${c.on.join(",")}`);
    u.comments.push(c);
  }
  return units;
}

function realDays(r: UkeReceipt): number {
  return new Set(r.lines.flatMap((l) => l.dates)).size;
}

/**
 * 書き出す合成の UKE の、資格確認・窓口負担額の設定（EM 5-1。合成の設定で、患者ごとの根拠はない）：
 * 確認区分 01（保険医療機関・薬局窓口等。別表29）、枝番 01、窓口負担額区分 00（高額療養費の現物給付なし。別表31）
 */
const SYNTHETIC = { confirmation: "01", branch: "01", copay: "00" } as const;

/** UKE の文字列（CRLF 区切り、EOF なし）。revOf は、書くときに使う版の決め方（既定は診療年月の版。版のない診療年月の合成の UKE を作るときだけ渡す） */
export function formatUke(file: UkeFile, revOf: (yearMonth: string) => Revision = resolveRevision): string {
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
  let grand = 0;
  file.receipts.forEach((r, idx) => {
    const p = r.patient;
    const rev = revOf(r.yearMonth);
    const units = unitsOf(rev, r);
    const total = units.reduce((s, u) => s + u.points * u.count, 0);
    grand += total;
    const days = realDays(r);
    const futan = futanKubun(p.kohi.length);
    // RE：項目 14（カルテ番号等）に請求 id を入れる
    rows.push(record(38, { 1: "RE", 2: idx + 1, 3: p.receiptType, 4: ym(r.yearMonth), 5: p.name, 6: p.sex, 7: p.birth, 14: r.claimId }));
    // 保険者番号は 8 桁に満たなければ、先頭を空白で埋める（国保の 6 桁。仕様 p9）
    rows.push(record(15, { 1: "HO", 2: p.insurer.number.padStart(8, " "), 3: p.insurer.symbol, 4: p.insurer.no, 5: days, 6: total }));
    for (const k of p.kohi) rows.push(record(12, { 1: "KO", 2: k.payerNo, 3: k.recipientNo, 5: days, 6: total }));
    // 資格確認（SN）：医療機関からの請求では、保険者レコードと、負担者番号が 12 で始まる公費レコードに対応するものを書く（仕様 p2 注4・p12）。
    // 枝番は医保だけ（後期高齢者医療は書かない）
    const lateElderly = p.insurer.number.startsWith("39") && p.insurer.number.length === 8;
    rows.push(record(9, { 1: "SN", 2: 1, 3: SYNTHETIC.confirmation, 7: lateElderly ? "" : SYNTHETIC.branch }));
    p.kohi.forEach((k, i) => {
      if (k.payerNo.startsWith("12")) rows.push(record(9, { 1: "SN", 2: i + 2, 3: SYNTHETIC.confirmation }));
    });
    // 受診日等（JD）：負担者ごとに 1 つ。算定のある日に「1（診療実日数に計上する受診）」（仕様 p13・別表30）
    const visited = new Set(r.lines.flatMap((l) => l.dates.map((d) => Number(d.slice(8, 10)))));
    for (let n = 1; n <= 1 + p.kohi.length; n++) rows.push(record(33, { 1: "JD", 2: n, ...Object.fromEntries([...visited].map((d) => [2 + d, 1])) }));
    // 窓口負担額（MF）：当分の間、一部負担金に係る区分を書く（仕様 p2 注5・p14）
    rows.push(record(33, { 1: "MF", 2: SYNTHETIC.copay }));
    for (const d of p.diseases) {
      // 傷病名コードがあるものは名称を書かない（名称を書くのは未コード化だけ）
      const code = d.code ?? diseaseCodeOf(d.name);
      rows.push(record(8, { 1: "SY", 2: code, 3: d.start, 4: d.outcome ?? 1, 5: (d.modifiers ?? []).join(""), 6: code === UNCODED_DISEASE ? d.name : "", 7: d.main ? "01" : "", 8: d.note ?? "" }));
    }
    const co = (shikibetsu: string, c: Comment) => record(5, { 1: "CO", 2: shikibetsu, 3: futan, 4: c.code, 5: c.raw });
    // 区分に付かないコメントは、レセプト全体へのコメントとして先頭に書く（2 件目からは診療識別を書かない。EM §2-10 表 4 の (e)）
    r.comments.filter((c) => c.on.length === 0).forEach((c, i) => rows.push(co(i === 0 ? WHOLE_RECEIPT : "", c)));
    for (const u of units) {
      u.rows.forEach((row, i) => {
        const cols: Record<number, string | number> = { 1: "SI", 3: futan, 4: row.code, 5: row.quantity, 7: u.count };
        if (i === 0) {
          cols[2] = rev.shikibetsu[u.kubun[0]];
          // 単位に付くコメントは、3 件まで先頭の行のコメント欄に書く
          u.comments.slice(0, 3).forEach((c, n) => {
            cols[8 + n * 2] = c.code;
            cols[9 + n * 2] = c.raw;
          });
        }
        if (i === u.rows.length - 1) cols[6] = u.points;
        u.days.forEach((v, d) => {
          if (v > 0) cols[14 + d] = v;
        });
        rows.push(record(44, cols));
      });
      // コメント欄に入りきらない分は、単位の直後の CO に書く（読み取りでは、どの単位に掛かるかが形式から決まらない置き場所）
      for (const c of u.comments.slice(3)) rows.push(co("", c));
    }
  });
  // 総件数は、保険者レコードと公費レコードの数の合計（記録条件仕様 GO の注）。書き出しは、どのレセプトにも HO を 1 つ書く
  rows.push(record(4, { 1: "GO", 2: file.receipts.reduce((s, r) => s + 1 + r.patient.kohi.length, 0), 3: grand, 4: "99" }));
  return `${rows.join("\r\n")}\r\n`;
}

/** UKE の文字列（formatUke の形）をバイト列にする（Shift_JIS、末尾 EOF） */
export const encodeUke = (text: string): Buffer => Buffer.concat([iconv.encode(text, "Shift_JIS"), Buffer.from([EOF])]);

/** UKE のバイト列（Shift_JIS、末尾 EOF） */
export function writeUke(file: UkeFile, revOf?: (yearMonth: string) => Revision): Buffer {
  return encodeUke(formatUke(file, revOf));
}

// ───────────────────────────────────────────────────────────────────────────
// 読み込み

/**
 * UKE のバイト列を、形式だけ見て読む（design.md §11-12・§11-14）。版を見ず、コードを区分に引かない。受け取れない入力は、行番号つきの UkeError にする。
 * 確かめること：大きさと行数の上限／Shift_JIS・CRLF・EOF／レコードの種類・列数・順／数字の項目の形と範囲／1 日の回数の上限／
 * 算定日と回数・同じ単位の行の回数と算定日がそろっていること・単位が点数の行で終わっていること／GO の総件数。
 * 点数・回数の算定単位は、点数が書いてある行で終わる（診療識別は区切りに使わない）。点数は 1 回分で、回数は単位の各行に同じ値（EM §2-10 表 4 の (a)〜(c)）。
 * 「カルテ番号等」の欄は患者の番号として持つだけで、請求 id にしない（文字種も重複も見ない。請求 id は読む側が渡す。design.md §11-11）。
 * 資格確認（SN）・受診日等（JD）・窓口負担額（MF）・包括評価対象外理由（GR）・症状詳記（SJ）は、読んで持つだけ（順は確かめない）。
 * 入院のレセプト・臓器提供者のレセプト情報（TI・TR・TS）を含むレセプト・仕様にないレコードを含むレセプトは、断らずに読めないレセプト（UkeClaim.unsupported）にして、
 * そのレセプトの摘要のレコードは読まない（項目数と長さだけを見る）
 */
export function parseUke(buf: Buffer): UkeParsed {
  const fail = (line: number | null, reason: string): never => {
    throw new UkeError(line, reason);
  };
  if (buf.length > UKE_LIMITS.maxBytes) fail(null, "ファイルが大きすぎる");
  // EOF(0x1A) は仕様では必須（記録条件仕様 第2章 (ク)）。ただ、受け渡しの途中で落ちることがあり、中身の読み方には関わらないので、
  // なければないまま読む（書き出しは今までどおり付ける）。最後のレコードが CRLF で終わることは下で確かめる
  const body = buf.length > 0 && buf[buf.length - 1] === EOF ? buf.subarray(0, buf.length - 1) : buf;
  if (body.length === 0) fail(null, "空のファイル");
  let text = "";
  try {
    text = new TextDecoder("shift_jis", { fatal: true }).decode(body);
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
    // 仕様にないレコードでも、識別情報の形（英大文字 2 字）なら項目数を確かめずに通し、下でそのレセプトだけを読めないものにする（DPC のレコードなど）
    if (columns === undefined && !/^[A-Z]{2}$/.test(c[0])) fail(i + 1, "未対応のレコード");
    if (columns !== undefined && c.length !== columns) fail(i + 1, "列数が合わない");
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

  const claims: UkeClaim[] = [];
  let cur: UkeClaim | null = null;
  let daysInMonth = 31;
  let stage = 0; // 0: RE の直後 1: HO/KO 2: SY 3: SI/IY/TO/CO
  /** 点数の行がまだ来ていない、作りかけの単位の行 */
  let pending: { item: UkeItem; count: number; days: number[] }[] = [];
  /** 作りかけの単位が、点数の行なしで終わっていないか（次のレセプト・GO の前で確かめる） */
  const closed = () => {
    if (pending.length > 0) fail(pending[pending.length - 1].item.line, "点数のない行で単位が終わっている");
  };
  /** いまのレセプトを、読めないものにする（理由は定型文）。そこまでの単位とコメントは捨て、次の RE までの摘要のレコードは読まない */
  const unsupported = (claim: UkeClaim, reason: string) => {
    claim.unsupported = reason;
    claim.units = [];
    claim.comments = [];
    pending = [];
  };
  recs.slice(1, -1).forEach((c, i) => {
    const line = i + 2;
    const kind = c[0];
    if (kind === "IR" || kind === "GO") fail(line, `${kind} の位置が不正`);
    if (kind === "RE") {
      closed();
      const yearMonth = month(c[3], line, "診療年月");
      const receiptType = digits(c[2], line, "レセプト種別", /^\d{4}$/);
      cur = {
        line,
        patientNo: c[13],
        receiptNo: c[1],
        // レセプト種別（別表5）の 4 桁目が奇数のものは入院
        ...(/[13579]$/.test(receiptType) ? { unsupported: UNREADABLE.inpatient } : {}),
        yearMonth,
        patient: {
          name: c[4],
          sex: int(c[5], line, "性別", 1, 2) as 1 | 2,
          birth: digits(c[6], line, "生年月日", /^\d{8}$/),
          receiptType,
          insurer: { number: "", symbol: "", no: "" },
          kohi: [],
          diseases: [],
        },
        total: null,
        realDays: null,
        kohiTotals: [],
        units: [],
        comments: [],
        eligibility: [],
        visits: [],
        copay: [],
        dpcExclusions: [],
        notes: [],
      };
      claims.push(cur);
      daysInMonth = new Date(Date.UTC(Number(c[3].slice(0, 4)), Number(c[3].slice(4, 6)), 0)).getUTCDate();
      stage = 0;
      return;
    }
    if (!cur) return fail(line, `RE より前に ${kind} がある`);
    if (kind === "HO" || kind === "KO") {
      if (stage > 1) fail(line, `${kind} の位置が不正（SY・SI の後）`);
      stage = 1;
      // 番号の桁数・検証番号はここでは断らない（患者情報チェック P01 が指摘として返す）。実日数と点数は数字であることだけを見る
      const realDays = int(c[4], line, "診療実日数", 0, 31);
      const declared = int(c[5], line, "合計点数", 0, UKE_LIMITS.maxPoints);
      if (kind === "HO") {
        cur.total = { line, points: declared };
        cur.realDays = realDays;
        // 8 桁に満たない保険者番号は、先頭が空白で埋めてある（仕様 p9）
        cur.patient.insurer = { number: c[1].trimStart(), symbol: c[2], no: c[3] };
      } else {
        cur.patient.kohi.push({ payerNo: c[1], recipientNo: c[2] });
        cur.kohiTotals.push(declared);
      }
    } else if (cur.unsupported !== undefined) {
      // 読めないレセプトの残りのレコードは、形式（項目数・長さ）だけを見て読み飛ばす
    } else if (kind === "TI" || kind === "TR" || kind === "TS") {
      // 臓器提供者のレセプト情報（仕様 p21〜23）。この後の SY・SI などは提供者のもので、受容者のレセプトの合計に入らない
      unsupported(cur, UNREADABLE.donor);
    } else if (!COLUMNS.has(kind)) {
      unsupported(cur, UNREADABLE.record);
    } else if (kind === "SN") {
      // 資格確認（仕様 p12）。保険者番号等・記号・番号・受給者番号は一次請求では記録されない。枝番は持たない
      cur.eligibility.push({ payerKind: digits(c[1], line, "負担者種別", /^[1-5]$/), confirmation: digits(c[2], line, "確認区分", /^\d{2}$/) });
    } else if (kind === "JD") {
      // 受診日等（仕様 p13）
      cur.visits.push({ payerKind: digits(c[1], line, "負担者種別", /^[1-5]$/), days: c.slice(2).map((v) => Number(digits(v, line, "受診等区分", /^\d?$/))) });
    } else if (kind === "MF") {
      // 窓口負担額（仕様 p14）。区分のほかは予備
      cur.copay.push(digits(c[1], line, "窓口負担額区分", /^\d{2}$/));
    } else if (kind === "GR") {
      // 包括評価対象外理由（仕様 p14）
      cur.dpcExclusions.push({ reason: digits(c[1], line, "医科点数表算定理由", /^\d{2}$/), dpcCode: c[2] });
    } else if (kind === "SJ") {
      // 症状詳記（仕様 p20）。区分を省略した行は、前の行の続き
      const noteKind = digits(c[1], line, "症状詳記区分", /^(\d{2})?$/);
      cur.notes.push({ kind: noteKind || (cur.notes[cur.notes.length - 1]?.kind ?? ""), text: c[2] });
    } else if (kind === "SY") {
      if (stage > 2) fail(line, "SY の位置が不正（SI の後）");
      stage = 2;
      const code = digits(c[1], line, "傷病名コード", /^\d{7}$/);
      const outcome = int(c[3], line, "転帰", 1, 4);
      // 未コード化は名称を読む。表にあるコードは表の名称にする。ほかのコードは、コードを保持して名称を持たない
      const known = diseaseNameOf(code);
      // 修飾語コードは 4 桁ずつ、20 個まで（仕様 p15）
      const modifiers = digits(c[4], line, "修飾語コード", /^([0-9A-Za-z]{4}){0,20}$/).match(/.{4}/g);
      cur.patient.diseases.push({
        ...(code === UNCODED_DISEASE ? { name: c[5] } : known !== null ? { name: known } : { name: "", code }),
        start: digits(c[2], line, "診療開始日", /^\d{8}$/),
        ...(c[6] === "01" ? { main: true } : {}),
        ...(outcome !== 1 ? { outcome: outcome as 2 | 3 | 4 } : {}),
        ...(modifiers ? { modifiers } : {}),
        ...(c[7] !== "" ? { note: c[7] } : {}),
      });
    } else if (kind === "SI" || kind === "IY" || kind === "TO") {
      stage = 3;
      const layout = ITEM_LAYOUT[kind];
      const shikibetsu = digits(c[1], line, "診療識別", /^(\d{2})?$/);
      const futan = digits(c[2], line, "負担区分", /^[0-9A-Z]$/);
      // 数量データ（SI。整数 8 桁）・使用量（IY は整数部 5 桁と小数部 5 桁、TO は 5 桁と 3 桁）。仕様 p16・18・19。3 つを 1 つの形で受ける。
      // TO は、回数のあとに単位コード（項目 8）・単価（9）・予備・商品名及び規格又はサイズ（300 バイトまで）が入る（EM §2-10 表 4 の (g)）。単位コードと単価は持ち、商品名は読み捨てる
      const item: UkeItem = {
        line,
        kind,
        code: digits(c[3], line, "コード", /^\d{9}$/),
        quantity: digits(c[4], line, "数量データ", /^(\d{1,8}(\.\d{1,5})?)?$/),
        shikibetsu,
        ...(kind === "TO" ? { unitCode: digits(c[7], line, "単位コード", /^(\d{1,3})?$/), unitPrice: digits(c[8], line, "単価", /^(\d{1,11}(\.\d{1,5})?)?$/) } : {}),
      };
      const points = c[5] === "" ? null : int(c[5], line, "点数", 0, UKE_LIMITS.maxPoints);
      // 回数も、算定日情報の 1 日の回数も 3 桁（仕様 p16〜19）
      const count = int(c[6], line, "回数", 1, UKE_LIMITS.maxDailyCount);
      const days: number[] = [];
      for (let d = 1; d <= 31; d++) {
        const v = c[layout.days + d - 1];
        // 1 日の回数は上限まで（大きな数で日付の並びを膨らませない）
        if (v !== "" && (!/^\d{1,3}$/.test(v) || Number(v) > UKE_LIMITS.maxDailyCount)) fail(line, "1 日の回数が上限を超えている");
        if (Number(v) > 0 && d > daysInMonth) fail(line, "診療年月にない日に回数がある");
        days.push(Number(v));
      }
      if (days.reduce((s, v) => s + v, 0) !== count) fail(line, "算定日の合計と回数が合わない");
      // 同じ単位の行は、回数も算定日も同じ（EM §2-10 表 4 の (b)・(g)）
      if (pending.length > 0 && (pending[0].count !== count || pending[0].days.join() !== days.join())) fail(line, "同じ単位の行で、回数・算定日がそろっていない");
      for (let n = 0; n < 3; n++) {
        const code = c[layout.comments + n * 2];
        const raw = c[layout.comments + n * 2 + 1];
        if (code === "" && raw === "") continue;
        cur.comments.push({ line, code: digits(code, line, "コメントコード", /^\d{9}$/), raw, unit: cur.units.length });
      }
      pending.push({ item, count, days });
      if (points !== null) {
        cur.units.push({ line, items: pending.map((p) => p.item), points, count, days, futan, shikibetsu: pending[0].item.shikibetsu });
        pending = [];
      }
    } else {
      // CO。コメントコードは形（数字 9 桁）だけを見る。診療行為のレコードより前にあってもよい
      stage = 3;
      const shikibetsu = digits(c[1], line, "診療識別", /^(\d{2})?$/);
      // 帰属が形式から決まるのは、単位の途中（点数の行より前）にある、診療識別が空の CO だけ
      const unit = shikibetsu === "" && pending.length > 0 ? cur.units.length : null;
      cur.comments.push({ line, code: digits(c[3], line, "コメントコード", /^\d{9}$/), raw: c[4], unit });
    }
  });
  closed();
  // 総件数は、レセプトごとの保険者レコード（HO）と公費レコード（KO）の数の合計（記録条件仕様 GO の注：医療保険と公費の併用は 2〜5 件と数える）。
  // RE の数ではない（2026-11-21 に仕様の注を読み直して直した。RE の数と照合していたので、公費の併用のあるファイルを読めなかった）
  const count = claims.reduce((s, c) => s + (c.total ? 1 : 0) + c.kohiTotals.length, 0);
  if (int(go[1], goLine, "総件数", 0, UKE_LIMITS.maxLines) !== count) fail(goLine, "GO の総件数と、保険者・公費のレコードの数が合わない");
  return {
    payer,
    prefecture: pref,
    clinic: { code: ir[4], name: ir[6], phone: ir[9] },
    billingMonth,
    claims,
    total: { line: goLine, points: int(go[2], goLine, "総合計点数", 0, UKE_LIMITS.maxPoints * 100) },
  };
}

/**
 * 単位を区分に引いた結果。引けなければ、理由（定型文。値は入れない）と行番号。
 * unsupported が真＝対応していないコードを含む単位（点検の対象外として残す）／偽＝対応しているコードだけなのに、点数・数量が版の表と食い違う単位（取り込みでは断る）。
 * revPoints は試算のときだけ（mapClaim の lenient）：UKE に書いてある 1 回分の点数が、版の点数（単位の合算。revPoints）と違う単位。断らずに行を引き、違いを並べる
 */
export type UnitMapping = { ok: true; lines: UkeLine[]; revPoints?: number } | { ok: false; line: number; reason: string; unsupported: boolean };

export type LineOrigin = { unit: number; codes: string[]; via: "primary" | "accept" | "bundle" };

export type MappedClaim = {
  /** 単位ごとの結果（UkeClaim.units と同じ並び） */
  units: UnitMapping[];
  /** 引けた単位の算定行（単位の並びのまま） */
  lines: UkeLine[];
  /**
   * lines と同じ並びの、行とコードの対応（design.md §12-2）：その行のもとになった単位の番号（UkeClaim.units の添字）と UKE のコード、
   * そのコードが版の表のどれだったか（primary／accept／包括の検査の項目 bundle）。エンジンの ClaimLine には入れない
   */
  origins: LineOrigin[];
  /** 点検の対象外の単位（対応していないコードを含む単位。単位の並びのまま） */
  others: UkeOther[];
  comments: Comment[];
};

const datesOf = (yearMonth: string, days: number[], times: number): string[] =>
  days.flatMap((n, i) => Array.from({ length: n * times }, () => `${yearMonth}-${String(i + 1).padStart(2, "0")}`));

/** 単位 1 つを、版の codes・bundles で算定行にする。lenient が真なら、点数だけが版と違う単位を断らず、版の点数（revPoints）を添えて返す */
function mapUnit(unit: UkeUnit, yearMonth: string, rev: Revision, lenient: boolean): UnitMapping {
  /** 食い違い（取り込みでは断る） */
  const no = (line: number, reason: string): UnitMapping => ({ ok: false, line, reason, unsupported: false });
  /** 対応していないコードを含む単位（点検の対象外として残す） */
  const out = (line: number, reason: string): UnitMapping => ({ ok: false, line, reason, unsupported: true });
  const other = unit.items.find((it) => it.kind !== "SI");
  if (other) return out(other.line, "医薬品・特定器材の行は、点検の対象にしていない");
  const unknown = unit.items.find((it) => kubunOfCode(rev, it.code) === null && bundleOfCode(rev, it.code) === null);
  if (unknown) return out(unknown.line, "診療年月の版の表にないコード");
  const dates = datesOf(yearMonth, unit.days, 1);

  // 包括の検査：単位の全部が、同じ包括の項目。項目数で区分が決まる
  const bundle = bundleOfCode(rev, unit.items[0].code);
  if (unit.items.some((it) => bundleOfCode(rev, it.code) !== bundle)) return out(unit.line, "包括の検査の項目と、ほかの項目が同じ単位にある");
  if (bundle) {
    const items = unit.items.map((it) => it.code);
    if (new Set(items).size !== items.length) return no(unit.line, "包括の検査の同じ項目が、同じ単位に 2 つある");
    if (unit.items.some((it) => it.quantity !== "")) return no(unit.line, "数量データに対応していない項目");
    const kubun = bundleKubun(bundle, items.length);
    // 包括にならない項目数（項目ごとに算定する）は、対応していない
    if (kubun === null) return out(unit.line, "包括の検査の項目数が、包括になる数に足りない");
    const listed = rev.points[kubun].points;
    if (unit.points !== listed) return lenient && listed !== null ? { ok: true, lines: [{ kubun, count: unit.count, dates, items }], revPoints: listed } : no(unit.line, "点数が診療年月の版の点数表と合わない");
    return { ok: true, lines: [{ kubun, count: unit.count, dates, items }] };
  }

  // それ以外：コード 1 つが区分 1 つ。単位の 1 回分の点数は、引いた区分の 1 回分の点数の合計（注加算は基本の項目と合算されている）
  const lines: UkeLine[] = [];
  let expected = 0;
  for (const it of unit.items) {
    const kubun = kubunOfCode(rev, it.code)!;
    const listed = rev.points[kubun].points;
    if (listed === null) return no(it.line, "点数のない区分で、点数を確かめられない");
    if (rev.codes[kubun].quantity) {
      // きざみで算定する区分：数量データが項目数で、行の回数は 項目数 × 回数（同じ日を項目数だけ重ねる）
      if (!/^[1-9]\d{0,2}$/.test(it.quantity)) return no(it.line, "数量データが項目数として読めない");
      const n = Number(it.quantity);
      if (n > UKE_LIMITS.maxQuantity) return no(it.line, "数量データが大きすぎる");
      expected += listed * n;
      lines.push({ kubun, count: unit.count * n, dates: datesOf(yearMonth, unit.days, n) });
    } else {
      if (it.quantity !== "") return no(it.line, "数量データに対応していない項目");
      expected += listed;
      lines.push({ kubun, count: unit.count, dates });
    }
  }
  if (unit.points !== expected) return lenient ? { ok: true, lines, revPoints: expected } : no(unit.line, "点数が診療年月の版の点数表と合わない");
  return { ok: true, lines };
}

/**
 * レセプト 1 件のコードを、渡された版の表で区分に引く（design.md §11-12・§11-14）。例外にせず、単位ごとに「引けた／引けない（理由）」を返す。
 * 引けない単位の行は lines に入れない。対応していないコードを含む単位は others に残す。コメントの on は、帰属が形式から決まり、その単位が引けたときだけ埋める。
 * lenient は試算（診療年月の版とは限らない版で読む。§11-12）：点数だけが版と違う単位は断らずに行を引き（UnitMapping.revPoints）、
 * ほかの食い違い（数量データが読めないなど）の単位は、点検の対象外の単位として others に残す
 */
export function mapClaim(claim: UkeClaim, rev: Revision, lenient = false): MappedClaim {
  // 算定日の列は「日ごとの回数 × 数量データ」個できる。作る前に数え、レセプト 1 件の上限を超えた単位からは行にしない
  // （小さなファイルでも、回数と数量を掛けると数億個になり得る。取り込みでも、保存済みの読み直しでも、試算でも同じ）。
  // 医薬品・特定器材を含む単位は行にしない（対象外の単位として、1〜31 日の回数のまま持つ）ので、数えない
  let budget: number = UKE_LIMITS.maxClaimCount;
  const units = claim.units.map((u): UnitMapping => {
    const quantity = u.items.some((it) => it.kind !== "SI") ? 0 : Math.max(1, ...u.items.map((it) => (/^\d{1,3}$/.test(it.quantity) ? Number(it.quantity) : 1))) * u.items.length;
    budget -= u.days.reduce((s, n) => s + n, 0) * quantity;
    if (budget < 0) return { ok: false, line: u.items[0]?.line ?? 0, reason: "算定回数の合計が多すぎる", unsupported: false };
    return mapUnit(u, claim.yearMonth, rev, lenient);
  });
  const comments = claim.comments.map((c: UkeComment): Comment => {
    const u = c.unit === null ? undefined : units[c.unit];
    return { code: c.code, text: normalizeCommentText(c.raw), raw: c.raw, on: u?.ok ? [...new Set(u.lines.map((l) => l.kubun))] : [] };
  });
  const others = units.flatMap((u, i): UkeOther[] => {
    if (u.ok === false && (u.unsupported || lenient)) {
      const unit = claim.units[i];
      return [{ unit: i, codes: unit.items.map((it) => it.code), points: unit.points, count: unit.count, days: unit.days }];
    }
    return [];
  });
  const origins = units.flatMap((u, i): LineOrigin[] => {
    if (!u.ok) return [];
    const items = claim.units[i].items;
    // 包括の検査は、単位の全部の項目が 1 行になる。ほかは、項目 1 つが 1 行（mapUnit の並びのまま）
    if (u.lines.length === 1 && u.lines[0].items) return [{ unit: i, codes: items.map((it) => it.code), via: "bundle" }];
    return u.lines.map((l, n) => ({ unit: i, codes: [items[n].code], via: rev.codes[l.kubun].primary === items[n].code ? "primary" : "accept" }));
  });
  return { units, lines: units.flatMap((u) => (u.ok ? u.lines : [])), origins, others, comments };
}

/**
 * レセプト 1 件を、診療年月の版で読む。対応していないコードを含む単位は、点検の対象外の単位として残す（design.md §11-11）。
 * 診療年月に当たる版がないレセプトは、コードを区分に引かずに残す（noRevision。近い版で代用しない。§11-12）。
 * 読めないとき（対応しているコードの単位の点数・数量が版の表と合わない／HO の合計点数が、対象外の単位も含めた行の合計と合わない）は、
 * 例外にせず、行番号と理由（定型文。値は入れない）を返す。取り込みで断るか、読み直しで unreadable にするかは、呼び出し側が決める
 */
function receiptOf(c: UkeClaim, claimId: string, revs: Revision[]): { ok: true; receipt: UkeReceipt } | { ok: false; line: number; reason: string } {
  const head = { claimId, patientNo: c.patientNo, yearMonth: c.yearMonth, patient: c.patient };
  const declared = { ho: c.total?.points ?? null, ko: c.kohiTotals };
  // 読めないレセプト（入院など）は、断らずに理由だけを持たせる。同じファイルのほかのレセプトは読む
  if (c.unsupported !== undefined) return { ok: true, receipt: { ...head, lines: [], declared, comments: [], commentsKnown: true, unreadable: { reason: c.unsupported } } };
  const totalBad = c.total && c.total.points !== insuredTotal(c) ? ({ ok: false, line: c.total.line, reason: "合計点数が行の合計と合わない" } as const) : null;
  // 合計の検査は版によらない（UKE に書いてある点数どうしを比べる）ので、版のないレセプトでも行う
  if (!hasRevision(c.yearMonth, revs)) return totalBad ?? { ok: true, receipt: { ...head, lines: [], declared, comments: [], commentsKnown: true, noRevision: true } };
  const mapped = mapClaim(c, resolveRevision(c.yearMonth, revs));
  const bad = mapped.units.find((u) => u.ok === false && !u.unsupported);
  if (bad && bad.ok === false) return { ok: false, line: bad.line, reason: bad.reason };
  if (totalBad) return totalBad;
  return {
    ok: true,
    receipt: {
      ...head,
      lines: mapped.lines,
      ...(mapped.others.length > 0 ? { others: mapped.others } : {}),
      declared,
      comments: mapped.comments,
      commentsKnown: true,
    },
  };
}

/** 請求 id の決め方（レセプトと、ファイルの中の通し番号（1 から）を受ける）。既定は「カルテ番号等」の欄をそのまま使う（同梱の見本は、この欄に症例の請求 id を書いてある） */
export type ClaimIdOf = (claim: UkeClaim, n: number) => string;
const patientNoAsId: ClaimIdOf = (c) => c.patientNo;

/**
 * UKE の取り込み（spec FR-106）。形式を読み（parseUke）、レセプトごとに診療年月の版でコードを区分に引く（mapClaim）。
 * 対応していないコードを含む単位は、断らずに点検の対象外の単位として残す（UkeReceipt.others。design.md §11-11）。
 * 対応しているコードの単位の点数の食い違い・HO の合計点数や GO の総合計点数と行の合計（対象外の単位も含む）の食い違いがあれば、
 * 行番号つきの UkeError にしてファイルごと断る（X-76）。診療年月に当たる版がないレセプトは断らず、noRevision として残す（design.md §11-12）。請求 id は claimId が決める（取り込んだ UKE はアプリが振る。src/uke/upload.ts）
 */
export function readUke(buf: Buffer, claimId: ClaimIdOf = patientNoAsId, revs: Revision[] = REVISIONS): UkeFile {
  const parsed = parseUke(buf);
  const receipts = parsed.claims.map((c, i): UkeReceipt => {
    const r = receiptOf(c, claimId(c, i + 1), revs);
    if (r.ok === false) throw new UkeError(r.line, r.reason);
    return r.receipt;
  });
  // GO の総合計点数は、各レセプトの主保険の合計点数（HO。HO のないレセプトは 1 件目の KO）の合計（仕様 p24）
  const grand = parsed.claims.reduce((s, c) => s + (c.total?.points ?? c.kohiTotals[0] ?? 0), 0);
  if (parsed.total.points !== grand) throw new UkeError(parsed.total.line, "GO の総合計点数と計算が合わない");
  return { payer: parsed.payer, prefecture: parsed.prefecture, clinic: parsed.clinic, billingMonth: parsed.billingMonth, receipts };
}

/** 読めなかったレセプトの理由（画面に出す文）。changed は読み直しで（design.md §11-12）、ほかは形式の読み取りで決まる（UkeClaim.unsupported） */
export const UNREADABLE = {
  changed: "取り込んだ後に表が変わり、点数が合わなくなりました",
  inpatient: "入院のレセプトは未対応です",
  donor: "臓器提供者のレセプト情報を含むレセプトは未対応です",
  record: "未対応のレコードを含むレセプトです",
} as const;

/**
 * 保存済みの UKE の読み直し（design.md §11-12・C-95）。断るのは取り込みの時だけで、ここではレセプトごとに読む：
 * 取り込んだ後にコードの表・点数表が変わって食い違うようになったレセプトは、例外にせず unreadable（理由つき。行とコメントは空）として返し、ほかのレセプトは今までどおり読む。
 * 形式そのものが読めないファイル（parseUke が断るもの）だけは UkeError になる
 */
export function readStoredUke(buf: Buffer, claimId: ClaimIdOf = patientNoAsId, revs: Revision[] = REVISIONS): UkeFile {
  const parsed = parseUke(buf);
  const receipts = parsed.claims.map((c, i): UkeReceipt => {
    const id = claimId(c, i + 1);
    const r = receiptOf(c, id, revs);
    if (r.ok) return r.receipt;
    return { claimId: id, patientNo: c.patientNo, yearMonth: c.yearMonth, patient: c.patient, lines: [], comments: [], commentsKnown: true, unreadable: { reason: UNREADABLE.changed } };
  });
  return { payer: parsed.payer, prefecture: parsed.prefecture, clinic: parsed.clinic, billingMonth: parsed.billingMonth, receipts };
}
