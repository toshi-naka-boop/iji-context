// 査定・返戻の記録を、提出した UKE の請求と、その中の行に当てる（spec FR-202 の I-1。design/iji-context/plan-i1.md「Fable の見立てで直すところ」3・4）。
// 決まった規則だけで当てる（AI は使わない）。1 つに決まらなければ当てず、人が選ぶ。自動で当てた分も、人が 1 回確かめる（確かめるのは呼び出し側）
import type { Payer } from "../engine/types";
import type { ReviewFileName, ReviewRow } from "./format";
import { CLAIM_LEVEL_JIYU } from "./reasons";

/** 提出した UKE のレセプト 1 件の鍵（src/server/app/uke.ts の receiptKeys）。insurers は保険者番号と公費負担者番号。checkable は今の版で点検できるか */
export type ReceiptKey = {
  claimId: string;
  payer: Payer;
  billingMonth: string;
  clinicCode: string;
  receiptNo: string;
  patientNo: string;
  yearMonth: string;
  name: string;
  insurers: string[];
  checkable: boolean;
  noRevision: boolean;
};

/** 氏名・名称を比べる形：NFKC にして、空白（全角も）を除く */
export const norm = (s: string): string => s.normalize("NFKC").replace(/\s/g, "");

/** 氏名と保険者番号（または公費負担者番号）が合うか。月遅れで明細に診療年月があれば、それも合うか */
function verified(row: ReviewRow, k: ReceiptKey): boolean {
  if (norm(row.name) !== norm(k.name)) return false;
  if (!row.insurers.some((n) => k.insurers.includes(n.trim()))) return false;
  return row.yearMonth === null || row.yearMonth === k.yearMonth;
}

export type ClaimMatch = { claimId: string } | { claimId: null; reason: string };

/**
 * 請求に当てる。
 * 増減点連絡書：審査支払機関（ファイル名）・医療機関コード・請求月（ファイル名の処理年月）が同じ UKE のレセプトのうち、カルテ番号等が両方にあって 1 件に決まればそれ、
 * 決まらなければレセプト番号で 1 件に決める。2 件以上（送信回をまたいで番号が重なる）・0 件なら当てない。当てたものは氏名と保険者番号で検算し、合わなければ当てない。
 * 返戻内訳書（レセプト番号を持たない）：審査支払機関・医療機関コードが同じレセプトのうち、カルテ番号等で 1 件に決まればそれ（検算する）、
 * 決まらなければ保険者番号＋氏名＋診療年月（明細になければヘッダの診療月）で 1 件に決める
 */
export function matchClaim(file: ReviewFileName, headerMonth: string | null, row: ReviewRow, keys: ReceiptKey[]): ClaimMatch {
  const none = (reason: string): ClaimMatch => ({ claimId: null, reason });
  const same = keys.filter((k) => k.payer === file.payer && k.clinicCode === file.clinicCode);
  if (file.kind === "zogen") {
    const pool = same.filter((k) => k.billingMonth === file.processedMonth);
    const byKarte = row.karte ? pool.filter((k) => k.patientNo !== "" && k.patientNo === row.karte) : [];
    let hit: ReceiptKey | undefined = byKarte.length === 1 ? byKarte[0] : undefined;
    if (!hit) {
      const byNo = (byKarte.length > 1 ? byKarte : pool).filter((k) => k.receiptNo === row.receiptNo);
      if (byNo.length > 1) return none("同じ請求月・同じレセプト番号の請求が 2 件以上ある（送信回をまたいで番号が重なる）");
      if (byNo.length === 0) return none("審査支払機関・請求月・レセプト番号の同じ請求がない");
      hit = byNo[0];
    }
    return verified(row, hit) ? { claimId: hit.claimId } : none("氏名か保険者番号が合わない");
  }
  const month = row.yearMonth ?? headerMonth;
  const byKarte = row.karte ? same.filter((k) => k.patientNo !== "" && k.patientNo === row.karte && k.yearMonth === month) : [];
  if (byKarte.length === 1) return verified(row, byKarte[0]) ? { claimId: byKarte[0].claimId } : none("氏名か保険者番号が合わない");
  const hits = same.filter((k) => k.yearMonth === month && norm(k.name) === norm(row.name) && row.insurers.some((n) => k.insurers.includes(n.trim())));
  if (hits.length > 1) return none("保険者番号・氏名・診療年月の同じ請求が 2 件以上ある");
  if (hits.length === 0) return none("保険者番号・氏名・診療年月の同じ請求がない");
  return { claimId: hits[0].claimId };
}

/** 請求の算定単位 1 つ（UKE の並びのまま）。shikibetsu は診療識別（省略された単位は前の単位から引き継いだ値）。codes は単位の行のコードと名称の候補（マスターの名称・版の表の名称） */
export type LineUnit = { unit: number; shikibetsu: string; codes: { code: string; names: string[] }[] };

/** 行に当てた結果。claim＝請求単位（行に当てない）／code＝1 つのコードに決まった／choose＝人が選ぶ（hits は名称が含まれていたコード。0 個か 2 個以上） */
export type LineMatch = { scope: "claim" } | { scope: "code"; code: string } | { scope: "choose"; hits: string[] };

/** 請求単位で扱う明細か：返戻内訳書、合計・食事・集計の行（種別 5・箇所2）、金額の増減、事由 F・G・H */
export function claimLevel(kind: ReviewFileName["kind"], row: ReviewRow): boolean {
  if (kind === "henrei") return true;
  if (row.recordType === 5 || row.kasho2 !== "" || row.amount !== null) return true;
  return row.jiyu.some((j) => CLAIM_LEVEL_JIYU.has(j));
}

/**
 * 行に当てる：請求内容の文字列と、行の名称を NFKC にして空白を除き、名称が文字列に含まれるコードを拾う（最長一致：ほかのコードの名称の一部でしかない名称は捨てる）。
 * 箇所1（診療識別）と同じ診療識別の単位があれば、その単位だけを見る（箇所1 の値の一覧は未確認なので、同じ値の単位がなければ絞らない）。
 * コードの単位で数える（同じコードが別の単位・別の日にあっても 1 つ）。1 つの単位の複数のコードが同じ名称で当たったら（包括の検査の区分の名称など）、その単位の先頭のコードにする
 */
export function matchLine(kind: ReviewFileName["kind"], row: ReviewRow, units: LineUnit[]): LineMatch {
  if (claimLevel(kind, row)) return { scope: "claim" };
  const text = norm(row.seikyu);
  const narrowed = row.kasho1 !== "" && units.some((u) => u.shikibetsu === row.kasho1) ? units.filter((u) => u.shikibetsu === row.kasho1) : units;
  const hits: { code: string; unit: number; name: string }[] = [];
  for (const u of narrowed) {
    for (const c of u.codes) {
      const name = c.names.map(norm).filter((n) => n !== "" && text.includes(n)).sort((a, b) => b.length - a.length)[0];
      if (name) hits.push({ code: c.code, unit: u.unit, name });
    }
  }
  const longest = hits.filter((h) => !hits.some((o) => o.code !== h.code && o.name.length > h.name.length && o.name.includes(h.name)));
  const codes = [...new Set(longest.map((h) => h.code))];
  if (codes.length === 1) return { scope: "code", code: codes[0] };
  if (codes.length > 1 && new Set(longest.map((h) => `${h.unit}\u0000${h.name}`)).size === 1) return { scope: "code", code: longest[0].code };
  return { scope: "choose", hits: codes };
}
