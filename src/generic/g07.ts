// G07 必須コメント（design.md §12-3）：コメント関連テーブル（［関］＝ファイル仕様説明書 令和8年度版。列の意味は src/masters/layout.ts）で、レセプトにある診療行為・医薬品・特定器材の
// コードごとに、算定すれば必ず要る記載を引き、そのコメントコードがレセプトのどこにもなければ指摘する。置き場所では判定しない（R17 と同じ。コメントコードは項目ごとに決まっている）。
// 見るのは「あるか・ないか」だけ。中身（日付・数値・文章）は読まない。
// 使う行（［関］p2〜7。どれも、原文の記載要領 別表Ⅰ・Ⅱ・Ⅳ の行で確かめた錨が EM §2-11 にある）：
//   コメント記載通知等が、行の種類に合う表：診療行為＝1（別表Ⅰ 医科）／医薬品＝5（別表Ⅱ）／特定器材＝8（別表Ⅳ）。別表Ⅲ（検査値。指定の病院だけ）・歯科・調剤・訪問看護は使わない
//   条件区分 01（その行為の算定が条件で、ほかの条件がない）と、入院外のレセプトでの 02・入外区分 2（入院外で算定した場合）
//   非算定理由コメント（その行為を算定しなかった場合に書く）でない行。抹消でなく、変更年月日が診療年月の末日以前の行（その後に変わった行は、前の中身がデータにないので使わない）
// 使わない行（点検の範囲に数を出す）：条件区分 00（条件は記載要領の文章にある）、03・13（複数回算定した場合。数えるのが回数か数量か、どの期間かが仕様に書かれていない）、
//   10〜12（DPC）、20・30（選定療養など）、入院か入院外かが分からないときの 02。診療行為を特定しない行（199999999 など）は、コードで引けないので当たらない。
// 組の読み方：同じ行為・同じ項番・同じ枝番の行を 1 つの組にする（枝番は「項番内の条件ごと」。［関］p3）。組にコメントが複数あるとき、選択（どれか 1 つ）か全部要るかは、表からは決まらない。
//   別表Ⅰ の原文で確かめた範囲では、選択肢・「初回である旨か前回の年月日」・「どちらかの値」が同じ枝番に並び、両方とも要る記載は別の枝番に分かれている（EM §2-11）。
//   どちらの読み方でも成り立つことだけを言う：組のコメントが 1 つもないときだけ指摘する（1 つでもあれば言わない）
import { pickSnapshot, sourcesOf, type MastersDb } from "../masters/db";
import type { GenericAbout, GenericAboutMore, GenericCheck, GenericClaim, GenericFinding } from "./types";

/** 行の種類 → コメント記載通知等の値と、記載要領の表の呼び名 */
const SHEET = { SI: { tsuchi: "1", name: "別表Ⅰ" }, IY: { tsuchi: "5", name: "別表Ⅱ" }, TO: { tsuchi: "8", name: "別表Ⅳ" } } as const;
export const COMMENT_TABLE = "コメント関連テーブル";

type Row = { tsuchi: string; kouban: string; edaban: string; comment_code: string; joken: string; hisantei: string; nyugai: string; change: string; changed_on: string; abolished_on: string };

/** 要る記載の組 1 つ。comments は、その組のコメントコード（どれか 1 つ以上が要る）。found＝レセプトに 1 つでもあるか */
export type CommentGroup = { kind: "SI" | "IY" | "TO"; code: string; units: number[]; kouban: string; edaban: string; comments: string[]; found: boolean };

/**
 * レセプトの行のコードごとの、要る記載の組と、使わなかった組の数（notUsed。条件が文章にある・複数回・DPC・選定療養など・診療年月の後に変わった行）。
 * コメントを持たない請求（claim.comments がない）は null。診療年月の世代のコメント関連テーブルがなければ skip
 */
export function commentGroupsOf(claim: GenericClaim, masters: MastersDb, about: GenericAbout): { groups: CommentGroup[]; notUsed: number } | { skip: string } | null {
  if (claim.comments === undefined) return null;
  const pick = pickSnapshot(masters, "comment_kanren", about.yearMonth, about.generation);
  if (pick === null) return { skip: `診療年月の世代（${about.generation}）のコメント関連テーブルがありません` };
  const ym = about.yearMonth.replace("-", "");
  const [start, end] = [`${ym}01`, `${ym}31`];
  const outpatient = (about as GenericAboutMore).outpatient;
  const have = new Set(claim.comments.map((c) => c.code));
  const rowsOf = masters.prepare("SELECT tsuchi, kouban, edaban, comment_code, joken, hisantei, nyugai, change, changed_on, abolished_on FROM comment_kanren WHERE snapshot = ? AND code = ? ORDER BY kouban, edaban, comment_code");
  const seen = new Map<string, { kind: "SI" | "IY" | "TO"; units: number[] }>();
  claim.units.forEach((u, i) => {
    for (const it of u.items) {
      const s = seen.get(it.code) ?? { kind: it.kind, units: [] };
      if (!s.units.includes(i)) s.units.push(i);
      seen.set(it.code, s);
    }
  });
  const groups: CommentGroup[] = [];
  let notUsed = 0;
  for (const [code, { kind, units }] of seen) {
    const byGroup = new Map<string, { kouban: string; edaban: string; used: boolean; skip: boolean; comments: string[] }>();
    for (const r of rowsOf.all(pick.snapshot, code) as Row[]) {
      if (r.tsuchi !== SHEET[kind].tsuchi || r.change === "1" || r.abolished_on < start) continue;
      const live = r.changed_on <= end && r.hisantei === "0";
      const used = live && (r.joken === "01" || (r.joken === "02" && r.nyugai === "2" && outpatient === true));
      // 入院で算定した場合の行は、入院外のレセプトには当たらない。算定しなかった場合の行は、行があることが条件でない（どちらも「使わなかった」に数えない）
      const skip = r.hisantei !== "0" || (r.joken === "02" && r.nyugai === "1" && outpatient === true);
      const key = `${r.kouban}/${r.edaban}`;
      const g = byGroup.get(key) ?? { kouban: r.kouban, edaban: r.edaban, used: true, skip: true, comments: [] };
      // 組の中に、使えない行が 1 つでもあれば、その組は使わない（条件の違う行が混ざる組は、どれが要るかを決められない）
      g.used &&= used;
      g.skip &&= skip;
      g.comments.push(r.comment_code);
      byGroup.set(key, g);
    }
    for (const g of byGroup.values()) {
      if (g.used) groups.push({ kind, code, units, kouban: g.kouban, edaban: g.edaban, comments: [...new Set(g.comments)], found: g.comments.some((c) => have.has(c)) });
      else if (!g.skip) notUsed++;
    }
  }
  return { groups, notUsed };
}

/** コメント関連テーブルの 1 枚についての断り書き（src/generic/lookup.ts の sheetNotesOf と同じ意味。later＝診療年月より後の 1 枚で代えている、newer＝読み方を確かめた版より新しい） */
export function commentKanrenNotesOf(db: MastersDb, about: GenericAbout): { later: boolean; newer: boolean } {
  const pick = pickSnapshot(db, "comment_kanren", about.yearMonth, about.generation);
  if (pick === null) return { later: false, newer: false };
  return { later: pick.later, newer: sourcesOf(db).some((s) => s.dataset === "comment_kanren" && s.snapshot === pick.snapshot && s.verified !== null && s.snapshot > s.verified) };
}

/** 画面に並べる候補の数（選択式で多いときは、先頭のいくつかと残りの数） */
const SHOWN = 3;
/** コメントマスターの名称（定型文）。文字データが続く定型文の末尾の「；」は落とす */
const phrase = (name: string): string => name.replace(/[；;]\s*$/, "");

/** G07 が点検していないこと（点検の範囲の説明に出す。数は、このレセプトの行について） */
export function g07NotDone(claim: GenericClaim, masters: MastersDb, about: GenericAbout): string[] {
  const r = commentGroupsOf(claim, masters, about);
  if (r === null) return ["必須コメントは、コメントを持つレセプトにだけ掛けます。ここの行にはコメントが付いていないので、点検していません"];
  if ("skip" in r) return [];
  const multi = r.groups.filter((g) => g.comments.length > 1).length;
  return [
    `必須コメント：このレセプトの行について見たのは、算定すれば必ず要る記載 ${r.groups.length} 組です（記載があるか・ないかだけで、中身は見ていません）。` +
      `${multi > 0 ? `そのうち、同じ項番・枝番にコメントコードが複数ある ${multi} 組は、どれか 1 つがあれば指摘しません（全部が要る組か、選択かを、表からは決められないため）。` : ""}` +
      `条件によって要る記載（条件は記載要領の文章にあります）・複数回算定したときの記載など、点検していない組は ${r.notUsed} 組です`,
  ];
}

export const g07: GenericCheck = {
  id: "G07",
  kind: "記載もれ",
  run(claim, masters, about) {
    const r = commentGroupsOf(claim, masters, about);
    if (r === null) return [];
    if ("skip" in r) return r;
    const names = pickSnapshot(masters, "comment", about.yearMonth, about.generation);
    const nameOf = masters.prepare("SELECT name FROM comment WHERE snapshot = ? AND code = ?");
    const label = (code: string): string => {
      const name = names === null ? undefined : (nameOf.get(names.snapshot, code) as { name: string } | undefined)?.name;
      return name ? `「${phrase(name)}」（${code}）` : `コメントコード ${code}`;
    };
    const out: GenericFinding[] = [];
    for (const g of r.groups) {
      if (g.found) continue;
      const one = g.comments.length === 1;
      const rest = g.comments.length - SHOWN;
      out.push({
        check: "G07",
        kind: "記載もれ",
        certainty: "確定",
        units: g.units,
        codes: [g.code],
        messageKey: one ? "G07.missing" : "G07.missing_any",
        params: {
          code: g.code,
          sheet: SHEET[g.kind].name,
          kouban: String(Number(g.kouban)),
          comment: one ? label(g.comments[0]) : `${g.comments.slice(0, SHOWN).map(label).join("、")}${rest > 0 ? ` ほか ${rest} 個` : ""}`,
          // 重なりの規則（src/generic/overlap.ts）が、手書きの R17 の同じ記載かどうかを見るのに使う
          comments: g.comments.join(","),
        },
        source: { data: COMMENT_TABLE, ref: `コメント記載通知等=${SHEET[g.kind].tsuchi}, 項番=${g.kouban}, 枝番=${g.edaban}, コード=${g.code}` },
      });
    }
    return out;
  },
};
