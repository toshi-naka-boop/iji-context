// G07 必須コメント（design.md §12-3）：コメント関連テーブル（［関］＝ファイル仕様説明書 令和8年度版。列の意味は src/masters/layout.ts）で、レセプトにある診療行為・医薬品・特定器材の
// コードごとに、算定すれば必ず要る記載を引き、そのコメントコードがレセプトのどこにもなければ指摘する。置き場所では判定しない（R17 と同じ。コメントコードは項目ごとに決まっている）。
// 見るのは「あるか・ないか」（と、下の記載の形）だけ。中身が正しいか（日付・数値・文章の意味）は読まない。
// 使う行（［関］p2〜7。どれも、原文の記載要領 別表Ⅰ・Ⅱ・Ⅳ の行で確かめた錨が EM §2-11 にある）：
//   コメント記載通知等が、行の種類に合う表：診療行為＝1（別表Ⅰ 医科）／医薬品＝5（別表Ⅱ）／特定器材＝8（別表Ⅳ）。別表Ⅲ（検査値。指定の病院だけ）・歯科・調剤・訪問看護は使わない
//   条件区分 01（その行為の算定が条件で、ほかの条件がない）と、入院外のレセプトでの 02・入外区分 2（入院外で算定した場合）
//   非算定理由コメント（その行為を算定しなかった場合に書く）でない行。抹消でなく、変更年月日が診療年月の末日以前の行（その後に変わった行は、前の中身がデータにないので使わない）
// 条件区分 00（条件は記載要領の文章にある）は判定しない。「記載が要ることがある項目」として、組（別表, 項番, 枝番）の単位で点検の範囲に畳んで並べる（design.md §17-1。conditionalOf）。
// 条件区分 03 のうち、材料加算の項番 0237 だけは、同じコードの回数で判定する（design.md §17-2。条件つき。2 回分・3 回分を回数で表す読みは明文なし〔EM §2-10 表 5 W-61d〕）。
// 使わない行（点検の範囲に数を出す）：0237 以外の 03・特定器材の 03・数量のある 0237・13（複数回算定した場合）、
//   10〜12（DPC）、20・30（選定療養など）、入院か入院外かが分からないときの 02。診療行為を特定しない行（199999999 など）は、コードで引けないので当たらない。
// 記載の形（design.md §17-3）：レセプトのコメントの文字データの形を、R17 と同じ関数（commentFormatOk）で見る。中身と請求の突き合わせはしない
// 組の読み方：同じ行為・同じ項番・同じ枝番の行を 1 つの組にする（枝番は「項番内の条件ごと」。［関］p3）。組にコメントが複数あるとき、選択（どれか 1 つ）か全部要るかは、表からは決まらない。
//   別表Ⅰ の原文で確かめた範囲では、選択肢・「初回である旨か前回の年月日」・「どちらかの値」が同じ枝番に並び、両方とも要る記載は別の枝番に分かれている（EM §2-11）。
//   どちらの読み方でも成り立つことだけを言う：組のコメントが 1 つもないときだけ指摘する（1 つでもあれば言わない）
import { commentFormatOk, dateOfWareki } from "../engine/comments";
import type { CommentRule, KisaiYoshi } from "../engine/revisions/types";
import { pickSnapshot, sourcesOf, type MastersDb } from "../masters/db";
import { normalizeCommentText } from "../uke/uke";
import { rowNamesOf } from "./lookup";
import type { GenericAbout, GenericAboutMore, GenericCheck, GenericClaim, GenericFinding, GenericUnitDetail } from "./types";

/** 行の種類 → コメント記載通知等の値と、記載要領の表の呼び名 */
const SHEET = { SI: { tsuchi: "1", name: "別表Ⅰ" }, IY: { tsuchi: "5", name: "別表Ⅱ" }, TO: { tsuchi: "8", name: "別表Ⅳ" } } as const;
export const COMMENT_TABLE = "コメント関連テーブル";
/** 回数で判定する条件区分 03 の項番（材料加算の 2 回分・3 回分。design.md §17-2） */
const KOUBAN_0237 = "0237";

type Kind = "SI" | "IY" | "TO";
type Row = { tsuchi: string; kouban: string; edaban: string; comment_code: string; joken: string; hisantei: string; nyugai: string; change: string; changed_on: string; abolished_on: string; kaisu: number };

/**
 * 要る記載の組 1 つ。comments は、その組のコメントコード（どれか 1 つ以上が要る）。found＝レセプトに 1 つでもあるか。
 * kaisu は条件区分 03（項番 0237）の組だけ：コメントが要る回数（［関］の算定回数）と、このレセプトのそのコードの回数（count）
 */
export type CommentGroup = { kind: Kind; code: string; units: number[]; kouban: string; edaban: string; comments: string[]; found: boolean; kaisu?: { need: number; count: number } };
/** 条件区分 00 の組 1 つ（行のコードごと）。判定しない（design.md §17-1） */
export type ConditionalRow = { kind: Kind; code: string; kouban: string; edaban: string; comments: string[] };

/** 版の摘要欄の表から、G07 に渡すもの（GenericAbout.kisai）。kubun は、このレセプトで算定のある区分（R17 が掛かる規則を決める。design.md §17-1 の C-470） */
export function kisaiOf(rev: { comments: CommentRule[]; kisaiYoshi: KisaiYoshi[] }, kubun: string[]): NonNullable<GenericAbout["kisai"]> {
  const has = new Set(kubun);
  return { yoshi: rev.kisaiYoshi, r17Codes: new Set(rev.comments.filter((r) => r.kubun.some((k) => has.has(k))).flatMap((r) => r.codes)) };
}

/**
 * レセプトの行のコードごとの、要る記載の組（01・入院外の 02・回数の分かる 0237）と、条件区分 00 の組（conditional）と、使わなかった組の数
 * （notUsed。0237 以外の 03・数量のある 0237・13・DPC・選定療養など・診療年月の後に変わった行）。
 * コメントを持たない請求（claim.comments がない）は null。診療年月の世代のコメント関連テーブルがなければ skip
 */
export function commentGroupsOf(claim: GenericClaim, masters: MastersDb, about: GenericAbout): { groups: CommentGroup[]; conditional: ConditionalRow[]; notUsed: number } | { skip: string } | null {
  if (claim.comments === undefined) return null;
  const pick = pickSnapshot(masters, "comment_kanren", about.yearMonth, about.generation);
  if (pick === null) return { skip: `診療年月の世代（${about.generation}）のコメント関連テーブルがありません` };
  const ym = about.yearMonth.replace("-", "");
  const [start, end] = [`${ym}01`, `${ym}31`];
  const outpatient = (about as GenericAboutMore).outpatient;
  const have = new Set(claim.comments.map((c) => c.code));
  const rowsOf = masters.prepare("SELECT tsuchi, kouban, edaban, comment_code, joken, hisantei, nyugai, change, changed_on, abolished_on, kaisu FROM comment_kanren WHERE snapshot = ? AND code = ? ORDER BY kouban, edaban, comment_code");
  // コードごとの単位と、回数（単位の回数の合計。別のコードの行は足さない）と、数量の書いてある行があるか（2 回分・3 回分の書き方が分からないので 0237 を判定しない）
  const seen = new Map<string, { kind: Kind; units: number[]; count: number; quantity: boolean }>();
  claim.units.forEach((u, i) => {
    const unit = u as GenericUnitDetail;
    for (const it of unit.items) {
      const s = seen.get(it.code) ?? { kind: it.kind, units: [], count: 0, quantity: false };
      if (!s.units.includes(i)) {
        s.units.push(i);
        s.count += unit.count ?? 1;
      }
      const q = (it.quantity ?? "").trim();
      if (q !== "" && Number(q) !== 1) s.quantity = true;
      seen.set(it.code, s);
    }
  });
  const groups: CommentGroup[] = [];
  const conditional: ConditionalRow[] = [];
  let notUsed = 0;
  for (const [code, { kind, units, count, quantity }] of seen) {
    const byGroup = new Map<string, { kouban: string; edaban: string; used: boolean; cond: boolean; multi: boolean; skip: boolean; kaisu: number; comments: string[] }>();
    for (const r of rowsOf.all(pick.snapshot, code) as Row[]) {
      if (r.tsuchi !== SHEET[kind].tsuchi || r.change === "1" || r.abolished_on < start) continue;
      const live = r.changed_on <= end && r.hisantei === "0";
      const used = live && (r.joken === "01" || (r.joken === "02" && r.nyugai === "2" && outpatient === true));
      // 入院で算定した場合の行は、入院外のレセプトには当たらない。算定しなかった場合の行は、行があることが条件でない（どちらも「使わなかった」に数えない）
      const skip = r.hisantei !== "0" || (r.joken === "02" && r.nyugai === "1" && outpatient === true);
      const key = `${r.kouban}/${r.edaban}`;
      const g = byGroup.get(key) ?? { kouban: r.kouban, edaban: r.edaban, used: true, cond: true, multi: true, skip: true, kaisu: Infinity, comments: [] };
      // 組の中に、使えない行が 1 つでもあれば、その組は使わない（条件の違う行が混ざる組は、どれが要るかを決められない）
      g.used &&= used;
      g.cond &&= live && r.joken === "00";
      g.multi &&= live && r.joken === "03" && kind === "SI" && r.kouban === KOUBAN_0237;
      g.skip &&= skip;
      g.kaisu = Math.min(g.kaisu, r.kaisu);
      g.comments.push(r.comment_code);
      byGroup.set(key, g);
    }
    for (const g of byGroup.values()) {
      const comments = [...new Set(g.comments)];
      const found = g.comments.some((c) => have.has(c));
      if (g.used) groups.push({ kind, code, units, kouban: g.kouban, edaban: g.edaban, comments, found });
      else if (g.cond) conditional.push({ kind, code, kouban: g.kouban, edaban: g.edaban, comments });
      // 数量の書いてある行は、2 回分・3 回分をどう表したかが分からないので判定しない（design.md §17-2）
      else if (g.multi && !quantity && g.kaisu > 0) groups.push({ kind, code, units, kouban: g.kouban, edaban: g.edaban, comments, found, kaisu: { need: g.kaisu, count } });
      else if (!g.skip) notUsed++;
    }
  }
  return { groups, conditional, notUsed };
}

/** 記載が要ることがある項目（条件区分 00）の 1 項番（design.md §17-1）。codes は当たる行為、branches は残った枝番と、そのコメントの定型文（先頭のいくつかと残りの数） */
export type ConditionalItem = { sheet: string; kouban: string; codes: { code: string; name: string | null }[]; branches: { edaban: string; comments: string[] }[]; summary: string | null; source: { em?: string; url?: string; page?: string } };
/** items は並べる項番、hidden は外した組の数（r17＝R17 がこのレセプトで見ている記載／present＝組のコメントのどれかがレセプトにある） */
export type Conditional = { items: ConditionalItem[]; hidden: { r17: number; present: number } };

/**
 * 記載が要ることがある項目（design.md §17-1。判断 A・B・C・F・G）。判定しない（指摘にしない）。組は（別表, 項番, 枝番）の単位で、
 * R17 がこのレセプトで見ている記載（about.kisai.r17Codes）を含む組と、組のコメントのどれかがレセプトにある組を外し、残りを（別表, 項番）ごとにまとめる。
 * 要旨は版の kisaiYoshi（EM に採用した行）だけ。表にない項番は要旨なし。G07 が動かない請求（コメントを持たない・表がない）は null
 */
export function conditionalOf(claim: GenericClaim, masters: MastersDb, about: GenericAbout): Conditional | null {
  const r = commentGroupsOf(claim, masters, about);
  if (r === null || "skip" in r) return null;
  const have = new Set((claim.comments ?? []).map((c) => c.code));
  const r17 = about.kisai?.r17Codes ?? new Set<string>();
  const byBranch = new Map<string, { kind: Kind; kouban: string; edaban: string; codes: Set<string>; comments: Set<string> }>();
  for (const c of r.conditional) {
    const key = `${SHEET[c.kind].tsuchi}/${c.kouban}/${c.edaban}`;
    const b = byBranch.get(key) ?? { kind: c.kind, kouban: c.kouban, edaban: c.edaban, codes: new Set<string>(), comments: new Set<string>() };
    b.codes.add(c.code);
    for (const x of c.comments) b.comments.add(x);
    byBranch.set(key, b);
  }
  const hidden = { r17: 0, present: 0 };
  const byItem = new Map<string, { kind: Kind; kouban: string; codes: Set<string>; branches: { edaban: string; comments: string[] }[] }>();
  for (const b of [...byBranch.values()].sort((x, y) => SHEET[x.kind].tsuchi.localeCompare(SHEET[y.kind].tsuchi) || x.kouban.localeCompare(y.kouban) || x.edaban.localeCompare(y.edaban))) {
    const comments = [...b.comments];
    if (comments.some((x) => r17.has(x))) hidden.r17++;
    else if (comments.some((x) => have.has(x))) hidden.present++;
    else {
      const key = `${SHEET[b.kind].tsuchi}/${b.kouban}`;
      const item = byItem.get(key) ?? { kind: b.kind, kouban: b.kouban, codes: new Set<string>(), branches: [] };
      for (const x of b.codes) item.codes.add(x);
      item.branches.push({ edaban: b.edaban, comments });
      byItem.set(key, item);
    }
  }
  const names = rowNamesOf(masters, about, { items: [...byItem.values()].flatMap((i) => [...i.codes].map((code) => ({ kind: i.kind, code }))), comments: [...byItem.values()].flatMap((i) => i.branches.flatMap((b) => b.comments)), diseases: [] });
  const yoshi = about.kisai?.yoshi ?? [];
  const items = [...byItem.values()].map((i): ConditionalItem => {
    const sheet = SHEET[i.kind].name;
    const y = yoshi.find((x) => x.sheet === sheet && x.kouban === i.kouban);
    // 要旨のない項番は、記載要領の PDF へのリンクだけ（ページは付けない）。記載要領の PDF は別表Ⅰ・Ⅱ・Ⅳ で 1 つ（EM §2-5 L-4）なので、別表によらず版の要旨の行の URL を使う（C-481・X-324）
    const url = y?.url ?? yoshi[0]?.url;
    return {
      sheet,
      kouban: String(Number(i.kouban)),
      codes: [...i.codes].map((code) => ({ code, name: names.items[code]?.name ?? null })),
      branches: i.branches.map((b) => ({ edaban: b.edaban, comments: shown(b.comments.map((c) => (names.comments[c] ? `「${phrase(names.comments[c])}」（${c}）` : `コメントコード ${c}`))) })),
      summary: y?.summary ?? null,
      source: y ? { em: y.em, url: y.url, page: y.page } : url ? { url } : {},
    };
  });
  return { items, hidden };
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

/** 先頭の SHOWN 個と、残りの数 */
const shown = (list: string[]): string[] => (list.length > SHOWN ? [...list.slice(0, SHOWN), `ほか ${list.length - SHOWN} 個`] : list);

/** G07 が点検していないこと（点検の範囲の説明に出す。数は、このレセプトの行について）。見た組／記載が要ることがある項目／判定していない組の 3 つ（design.md §17-4） */
export function g07NotDone(claim: GenericClaim, masters: MastersDb, about: GenericAbout): string[] {
  const r = commentGroupsOf(claim, masters, about);
  if (r === null) return ["必須コメントは、コメントを持つレセプトにだけ掛けます。ここの行にはコメントが付いていないので、点検していません"];
  // 表がなくても形の指摘があれば G07 は動いたことになる（design.md §17-3）。そのときは、記載があるか・ないかを見ていないことを出す
  if ("skip" in r) return [formOnlyNote(r.skip)];
  const always = r.groups.filter((g) => g.kaisu === undefined);
  const multi = always.filter((g) => g.comments.length > 1).length;
  const conditional = conditionalOf(claim, masters, about);
  return [
    `必須コメント：このレセプトの行について見たのは、算定すれば必ず要る記載 ${always.length} 組と、材料加算の 2 回分・3 回分の記載（項番 237）${r.groups.length - always.length} 組です（記載の形〔年月日・時刻・数値など〕は見ていますが、中身が正しいかは見ていません）。` +
      `${multi > 0 ? `そのうち、同じ項番・枝番にコメントコードが複数ある ${multi} 組は、どれか 1 つがあれば指摘しません（全部が要る組か、選択かを、表からは決められないため）` : ""}`,
    `記載が要ることがある項目 ${conditional?.items.length ?? 0} 件は、判定していません（条件は記載要領の文章にあります。条件に当たるかは記載要領で確かめてください）`,
    `判定していない組（項番 237 以外の複数回算定の記載・数量の書いてある項番 237・診療年月の後に変わった行・DPC など）は ${r.notUsed} 組です`,
  ];
}

/** 記載の形を見るコメントの種類（コードの先頭 3 桁。EM §2-10 表 3）と、形の説明 */
const FORMS: Record<string, string> = {
  "830": "定型文の後の文字",
  "842": "数値（数字と小数点・符号）",
  "850": "和暦の年月日 7 桁（年号・年・月・日）",
  "851": "時刻 4 桁（時・分）",
  "852": "時間（分）5 桁",
};

/**
 * 記載の形（design.md §17-3）：R17 と同じ commentFormatOk で見る。850 で年号・年・月が正しく日だけが 00 のときは、年月だけのコードがあり得るので条件つき（form_day00）。
 * 850 の日付が診療年月の末日より後なら条件つき（form_future。予定日を書く記載があり得る）。診療年月より前の日付は言わない
 */
function formFindings(claim: GenericClaim, about: GenericAbout, label: (code: string) => string): GenericFinding[] {
  const out: GenericFinding[] = [];
  const last = `${about.yearMonth}-31`;
  for (const c of claim.comments ?? []) {
    const prefix = c.code.slice(0, 3);
    if (!Object.hasOwn(FORMS, prefix) || c.raw === undefined) continue;
    const text = normalizeCommentText(c.raw);
    let key: string | null = null;
    if (!commentFormatOk(c.code, text)) key = prefix === "850" && /^\d{5}00$/.test(text) && dateOfWareki(`${text.slice(0, 5)}01`) !== null ? "G07.form_day00" : "G07.form";
    else if (prefix === "850" && (dateOfWareki(text) as string) > last) key = "G07.form_future";
    if (key === null) continue;
    out.push({
      check: "G07",
      kind: "記載もれ",
      certainty: key === "G07.form" ? "確定" : "条件つき",
      units: c.unit === null || c.unit === undefined ? [] : [c.unit],
      codes: [],
      messageKey: key,
      // line（UKE の行番号）は、重なりの規則（src/generic/overlap.ts）が、同じコメントの行に R17 の指摘があるかを見るのに使う
      params: { comment: label(c.code), commentCode: c.code, text, form: FORMS[prefix], ...(c.line === undefined ? {} : { line: String(c.line) }) },
      source: { data: "コメントの形式", ref: `EM §2-10 表 3 先頭 3 桁=${prefix}, コード=${c.code}` },
    });
  }
  return out;
}

/** コメントマスターの名称（定型文）とコード。名称がなければコードだけ */
function labelOf(masters: MastersDb, about: GenericAbout): (code: string) => string {
  const names = pickSnapshot(masters, "comment", about.yearMonth, about.generation);
  const nameOf = masters.prepare("SELECT name FROM comment WHERE snapshot = ? AND code = ?");
  return (code) => {
    const name = names === null ? undefined : (nameOf.get(names.snapshot, code) as { name: string } | undefined)?.name;
    return name ? `「${phrase(name)}」（${code}）` : `コメントコード ${code}`;
  };
}

/** 記載があるか・ないかを見ずに、形だけを見たときの点検の範囲の文（reason は見なかった理由） */
export const formOnlyNote = (reason: string): string => `必須コメント：${reason}。記載の形（年月日・時刻・数値など）は見ました（記載があるか・ないかは表がないので見ていません）`;

/**
 * G07 の準備ができていない（コメント関連テーブルがない・錨が通らない）masters.db でも、記載の形だけは見る（design.md §17-3。X-320）。
 * 形はコードの先頭 3 桁だけで決まり、関連テーブルを読まない。コメントを持たない請求は null（掛けない）
 */
export function g07FormOnly(claim: GenericClaim, masters: MastersDb, about: GenericAbout): GenericFinding[] | null {
  return claim.comments === undefined ? null : formFindings(claim, about, labelOf(masters, about));
}

export const g07: GenericCheck = {
  id: "G07",
  kind: "記載もれ",
  run(claim, masters, about) {
    const r = commentGroupsOf(claim, masters, about);
    if (r === null) return [];
    const label = labelOf(masters, about);
    // 記載の形は、コードの先頭 3 桁だけで決まるので、診療年月の世代のコメント関連テーブルがなくても見る（design.md §17-3 の C-471。記載があるか・ないかは見ない）。
    // 形の誤りがなくても「動いた」にする（見て通ったことを点検の範囲に出す。C-482）
    if ("skip" in r) return formFindings(claim, about, label);
    const r17 = about.kisai?.r17Codes ?? new Set<string>();
    const out: GenericFinding[] = [];
    for (const g of r.groups) {
      if (g.found) continue;
      // 項番 0237：回数が［関］の算定回数に届かなければ要らない。R17 がこのレセプトで見ている記載なら言わない（design.md §17-2）
      if (g.kaisu && (g.kaisu.count < g.kaisu.need || g.comments.some((c) => r17.has(c)))) continue;
      const one = g.comments.length === 1;
      const rest = g.comments.length - SHOWN;
      out.push({
        check: "G07",
        kind: "記載もれ",
        // 0237 は、2 回分・3 回分を回数で表す読み（明文なし。EM §2-10 表 5 W-61d）に依るので言い切らない
        certainty: g.kaisu ? "条件つき" : "確定",
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
          // 条件区分 03（項番 0237）：文言の {when} に回数と読みの断りを入れる
          ...(g.kaisu ? { joken: "03", when: `（このレセプトでは ${g.kaisu.count} 回。${g.kaisu.need} 回以上算定するとき。2 回分・3 回分を回数で表すという読み〔明文なし〕による）` } : {}),
        },
        source: { data: COMMENT_TABLE, ref: `コメント記載通知等=${SHEET[g.kind].tsuchi}, 項番=${g.kouban}, 枝番=${g.edaban}, コード=${g.code}` },
      });
    }
    out.push(...formFindings(claim, about, label));
    return out;
  },
};
