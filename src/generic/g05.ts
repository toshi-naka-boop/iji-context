// G05 背反（design.md §12-3）：背反関連テーブルの 4 表（[点] p16・p28。masters.db では tani で分ける）に載っている組が、その表の単位の中に両方あるかを見る。
//   1 日につき（tani 1）… 同じ算定日に両方あれば、言い切りの候補
//   同一月内（tani 2）… 同じレセプトに両方あれば、言い切りの候補
//   同時（tani 3）… 同じ算定単位（点数・回数の単位）に両方あれば、言い切りの候補。別の単位でも、同じ算定日にあれば条件つき（同時に行ったかはレセプトから決まらない。X-96・C-100）
//   1 週間につき（tani 4）… 7 日以内（算定日の差が 6 日以内）に両方あれば、条件つき。起算日から 7 日か暦の週かは項目ごとに違い、データにないので、言い切らない
// 特例条件が 1 の行（[点] p28。条件の中身はデータにない）は、どの表でも条件つき。ただし、例外の決まり（EM §2-12。config/haihan-exceptions.json）の組に当たる行は、
// 例外を全部見て決める（design.md §13-2）：どれかに当たる → 出さない（要件・記載が要れば、それを挙げる）／全部に当たらない → exception_none／それ以外 → 条件つき（問いがあれば添える）。
// 1 週間の表（tani 4）には例外を掛けない（§13-2）。
// 背反区分（[点] p28 項番6）：1＝コード①を算定する／2＝コード②を算定する／3＝いずれか一方。残す側が決まる組（1・2）は、指摘の値（keep）に入れる。
// 表は組を両向きに持つ（[点] p22・p35）。同じ組は 1 回だけ言う：コードの小さいほうがコード①の行を使い、その向きの行がない組は、ある向きの行を使う
// 院内の知識（design.md §14-3）：特例条件が 1 の行（1 日・同一月・同時の表）のうち、(i) どの組（HP）にも当たらない、または (ii) 未決の問いがなく「決まらない」になったものに、
// その組の院内層・ベテラン層の codePair の知識（承認済み）を添える。添え方は本人のレベルで分ける（src/generic/local-pair.ts）。§13 で決まったもの・問いが未決のものには添えない
import { sameDayOf } from "../engine/predicates";
import { FACT_LABEL } from "../messages";
import { pickSnapshot, shinryoOf, type MastersDb, type ShinryoRow } from "../masters/db";
import { HAIHAN, haihanKey, sharedFactOf, type Check, type CodeSel, type HaihanConfig, type HaihanException, type HaihanPattern, type Means, type ReceiptCond } from "./haihan";
import { commonDays, daysText, noTensuhyo, occurrencesOf, TABLE, tensuhyoOf, unitsOf, type Dated, type Occurrence, type TimedClaim } from "./tensuhyo";
import { FINDING_LIMIT, type GenericAbout, type GenericAboutMore, type GenericCheck, type GenericClaim, type GenericFinding } from "./types";
import { LOCAL_PAIR_MIN_LEVEL, localKey, pairOf, type LocalAttach } from "./local-pair";

type Row = Dated & { tani: number; code1: string; code2: string; kubun: string; tokurei: string };

/** 7 日以内にある日の組（a の日・b の日。最初の 1 組）。なければ null */
function within7(a: Occurrence, b: Occurrence): [number, number] | null {
  if (!a.timed || !b.timed) return null;
  for (let d = 0; d < 31; d++) {
    if (a.days[d] === 0) continue;
    for (let e = Math.max(0, d - 6); e <= Math.min(30, d + 6); e++) if (b.days[e] > 0) return [d + 1, e + 1];
  }
  return null;
}

/** 問い 1 つ：key は答えを残す key（haihan:* か、sameDayOf が名指しした事実 sameDaySeparate）。dates は答えの日（請求ごとの問いは空） */
export type PendingAsk = { hx: string; key: string; dates: string[] };
/** 例外 1 つの結果。miss の answered は、答え（事実）で決まったか */
type ExResult = { r: "hit" } | { r: "miss"; answered: boolean } | { r: "open"; asks: PendingAsk[] } | { r: "undecided"; split?: { hit: string[]; miss: string[] } };

/** 請求 1 件の、例外の判定に使うもの */
type Ctx = {
  occ: Map<string, Occurrence>;
  comments: string[];
  outpatient: boolean | undefined;
  yearMonth: string;
  answers: GenericAbout["answers"];
  facts: GenericAbout["facts"];
  selects(code: string, sel: CodeSel): boolean;
};

const dateOf = (ym: string, day: number) => `${ym}-${String(day).padStart(2, "0")}`;
const shortDays = (dates: string[]) => dates.map((d) => String(Number(d.slice(8, 10)))).join("・");

/** レセプトの条件。決まらない（入院外かが分からない）ときは undefined */
function cond(c: ReceiptCond, x: Ctx, day: number | undefined): boolean | undefined {
  if ("all" in c) {
    const r = c.all.map((y) => cond(y, x, day));
    return r.includes(false) ? false : r.includes(undefined) ? undefined : true;
  }
  if ("any" in c) {
    const r = c.any.map((y) => cond(y, x, day));
    return r.includes(true) ? true : r.includes(undefined) ? undefined : false;
  }
  if ("not" in c) {
    const r = cond(c.not, x, day);
    return r === undefined ? undefined : !r;
  }
  if ("hasCode" in c) return [...x.occ.entries()].some(([code, o]) => x.selects(code, c.hasCode) && (!c.sameDay || day === undefined || (o.timed && o.days[day - 1] > 0)));
  // コメントは日付を持たないので、sameDay でも請求の中で見る（§11-5。X-107）
  if ("hasComment" in c) return x.comments.some((code) => c.hasComment.includes(code));
  return x.outpatient === undefined ? undefined : (c.receiptKind === "入院外") === x.outpatient;
}

/** 答えの文字列を、その問いの選択肢の means にする。選択肢にない（古い）答えは「決まらない」 */
const meansOf = (x: HaihanException, label: string): Means => x.ask?.choices.find((c) => c.label === label)?.means ?? "決まらない";

/** 日ごとの結果を 1 つにまとめる（design.md §13-2：どの日も当たる → 当たる、どの日も当たらない → 当たらない、分かれたら決まらない） */
function merge(list: { date: string; r: ExResult }[]): ExResult {
  const open = list.flatMap((e) => (e.r.r === "open" ? e.r.asks : []));
  if (open.length > 0) return { r: "open", asks: open };
  if (list.length === 0 || list.some((e) => e.r.r === "undecided")) return { r: "undecided" };
  if (list.every((e) => e.r.r === "hit")) return { r: "hit" };
  if (list.every((e) => e.r.r === "miss")) return { r: "miss", answered: list.some((e) => e.r.r === "miss" && e.r.answered) };
  return { r: "undecided", split: { hit: list.filter((e) => e.r.r === "hit").map((e) => e.date), miss: list.filter((e) => e.r.r === "miss").map((e) => e.date) } };
}

/** 医療事務の答え 1 つ（その日の、またはその請求の） */
function answerOn(x: HaihanException, codes: [string, string], date: string | null, c: Ctx): ExResult {
  const key = haihanKey(x.id, codes[0], codes[1]);
  // 既存の事実を使う問い（sameDayOushinAfterVisit）は、R10 と同じ関数（sameDayOf）で読む（C-114）。after → 当たる／not_after・same → 当たらない／決まらなければ、sameDayOf が名指しする事実を問う（C-117）
  if (sharedFactOf(x) !== null && date !== null) {
    if (c.facts) {
      const s = sameDayOf({ facts: c.facts }, date);
      if (s.known) return s.value === "after" ? { r: "hit" } : { r: "miss", answered: true };
      const a = c.answers?.(key, date) ?? null;
      // 「その他」「判定不能」と答えた日は、共有の事実を取り消して haihan:* に答えを残している（もう問わない。X-105）
      if (a !== null) return toResult(meansOf(x, a));
      return { r: "open", asks: [{ hx: x.id, key: "need" in s && s.need === "sameDaySeparate" ? "sameDaySeparate" : key, dates: [date] }] };
    }
    return { r: "open", asks: [{ hx: x.id, key, dates: [date] }] };
  }
  const a = c.answers?.(key, date) ?? null;
  return a === null ? { r: "open", asks: [{ hx: x.id, key, dates: date === null ? [] : [date] }] } : toResult(meansOf(x, a));
}
const toResult = (m: Means): ExResult => (m === "当たる" ? { r: "hit" } : m === "当たらない" ? { r: "miss", answered: true } : { r: "undecided" });

/**
 * 例外 1 つを、背反の行の 1 つの単位（day：1 日・同時の表は算定日、同一月の表は undefined）で判定する。aCode は、組の a 側に当たるコード。
 * pre が成り立たない → 当たらない／receipt → allow で決まる／fact → 答え／none → 決まらない。当たったあと、すでにある事実で確かめられる要件が満たされないと分かっていれば、当たらない（C-121）
 */
function judge(x: HaihanException, row: Row, aCode: string, day: number | undefined, c: Ctx): ExResult {
  if (x.pre) {
    const p = cond(x.pre, c, day);
    if (p === false) return { r: "miss", answered: false };
    if (p === undefined) return { r: "undecided" };
  }
  let out: ExResult;
  if (x.kind === "none") return { r: "undecided" };
  if (x.kind === "receipt") {
    const a = cond(x.allow!, c, day);
    out = a === true ? { r: "hit" } : a === false ? { r: "miss", answered: false } : { r: "undecided" };
  } else {
    const ask = x.ask!;
    const codes: [string, string] = [row.code1, row.code2];
    if (ask.scope === "claim") out = answerOn(x, codes, null, c);
    else if (day !== undefined) out = answerOn(x, codes, dateOf(c.yearMonth, day), c);
    else {
      // 同一月の表の、日ごとの問い：askOn の側のコードの算定日ごとに問う（C-115）
      const code = (ask.askOn ?? "b") === "a" ? aCode : aCode === row.code1 ? row.code2 : row.code1;
      const o = c.occ.get(code);
      const days = o && o.timed ? o.days.flatMap((n, i) => (n > 0 ? [i + 1] : [])) : [];
      out = merge(days.map((d) => ({ date: dateOf(c.yearMonth, d), r: answerOn(x, codes, dateOf(c.yearMonth, d), c) })));
    }
  }
  if (out.r === "hit") for (const k of x.thenRequires?.checks ?? []) if (checkOf(k, c) === "miss") return { r: "miss", answered: true };
  return out;
}

/** すでにある事実で確かめられる要件：満たす（ok）／当たらない（miss）／要件として挙げる一言（不明なら要件の一言、maybe の値ならその一言） */
function checkOf(k: Check, c: Ctx): "ok" | "miss" | string {
  const f = k.fact ? (c.facts as Record<string, { known: boolean; value?: unknown }> | undefined)?.[k.fact.key] : undefined;
  if (!k.fact || !f?.known || f.value === null || f.value === undefined) return k.text;
  const v = String(f.value);
  return k.fact.ok.includes(v) ? "ok" : (k.fact.maybe?.[v] ?? "miss");
}

/** 1 つの単位の、組の例外を全部見た結果 */
type SlotOutcome =
  | { kind: "silent"; hx: string[] }
  | { kind: "require"; hx: HaihanException[]; checks: string[]; comments: string[] }
  | { kind: "none"; answered: boolean }
  | { kind: "open"; asks: PendingAsk[]; hx: string[]; split?: { hx: string; hit: string[]; miss: string[] } };

function outcomeOf(p: HaihanPattern, config: HaihanConfig, row: Row, aCode: string, day: number | undefined, c: Ctx): SlotOutcome {
  const list = p.exceptions.map((id) => config.exceptions.find((e) => e.id === id)!).map((x) => ({ x, r: judge(x, row, aCode, day, c) }));
  const hits = list.filter((e) => e.r.r === "hit").map((e) => e.x);
  if (hits.length > 0) {
    // thenRequires のない例外に当たった組だけ、何も出さない
    if (hits.some((x) => !x.thenRequires)) return { kind: "silent", hx: hits.filter((x) => !x.thenRequires).map((x) => x.id) };
    const checks = hits.flatMap((x) => (x.thenRequires?.checks ?? []).map((k) => checkOf(k, c)).filter((t) => t !== "ok" && t !== "miss"));
    const comments = [...new Set(hits.flatMap((x) => x.thenRequires?.comments ?? []))];
    return checks.length === 0 && comments.length === 0 ? { kind: "silent", hx: hits.map((x) => x.id) } : { kind: "require", hx: hits, checks, comments };
  }
  if (list.every((e) => e.r.r === "miss")) return { kind: "none", answered: list.some((e) => e.r.r === "miss" && e.r.answered) };
  const asks = list.flatMap((e) => (e.r.r === "open" ? e.r.asks : []));
  const split = list.find((e) => e.r.r === "undecided" && e.r.split);
  return { kind: "open", asks, hx: list.filter((e) => e.r.r === "open" || e.r.r === "undecided").map((e) => e.x.id), ...(split && split.r.r === "undecided" && split.r.split ? { split: { hx: split.x.id, ...split.r.split } } : {}) };
}

/** 診療行為が選び方に当たるか（区分番号は、診療年月に使う基本マスターの 1 枚で引く。引けなければ当たらない）。答えの入力の検査も使う */
export function selectorOf(db: MastersDb, about: GenericAbout): (code: string, sel: CodeSel) => boolean {
  const snap = pickSnapshot(db, "shinryo", about.yearMonth, about.generation)?.snapshot ?? null;
  const rows = new Map<string, ShinryoRow | null>();
  return (code, sel) => {
    if (sel.codes?.includes(code)) return true;
    const s = sel.section;
    if (!s || snap === null) return false;
    if (!rows.has(code)) rows.set(code, shinryoOf(db, snap, code));
    const r = rows.get(code);
    return !!r && r.sho === s.sho && r.bu === s.bu && r.kubun_no === s.kubun && (s.eda === undefined || r.eda === s.eda) && (s.kou === undefined || r.kou === s.kou);
  };
}

/** 背反の行が当たる組（向きはどちらでも）と、組の a 側のコード */
function patternOf(config: HaihanConfig, row: Row, selects: Ctx["selects"]): { p: HaihanPattern; aCode: string } | null {
  for (const p of config.patterns) {
    if (!(p.tani as number[]).includes(row.tani)) continue;
    if (selects(row.code1, p.a) && selects(row.code2, p.b)) return { p, aCode: row.code1 };
    if (selects(row.code1, p.b) && selects(row.code2, p.a)) return { p, aCode: row.code2 };
  }
  return null;
}

/**
 * 院内の知識を添える（design.md §14-3）。make は、残った日（1 日・同時の表は算定日、同一月の表は undefined の 1 つ）で指摘を作る関数。
 * 戻り値は出す指摘（0 件＝押した事実で全部の日を出さない）。used・silenced に、添えた承認済みの知識の id と、出さなかった日の知識の id を足す
 */
function withLocal(about: GenericAbout, ym: string, row: Row, days: (number | undefined)[], make: (days: (number | undefined)[], messageKey?: string, params?: Record<string, string>) => GenericFinding, out: { used: string[]; silenced: string[] }): GenericFinding[] {
  if (!about.localKnowledge) return [make(days)];
  const pair = pairOf(row.code1, row.code2, row.tani as 1 | 2 | 3);
  const list = about.localKnowledge(pair);
  const approved = list.filter((k) => k.status === "承認済み");
  const allow = approved.filter((k) => k.polarity === "allow");
  const avoid = approved.filter((k) => k.polarity === "avoid");
  const view = (ks: typeof list) => ks.map((k) => ({ id: k.id, rev: k.rev, polarity: k.polarity, conditionNote: k.conditionNote }));
  // 対象の指摘には組を印として付ける（作る入口を出す。design.md §14-2）
  const tag = { localPair: JSON.stringify(pair) };
  const attach = (mode: LocalAttach["mode"], ks: typeof list, dates: string[] = []): Record<string, string> => ({ ...tag, local: JSON.stringify({ mode, pair, knowledge: view(ks), dates } satisfies LocalAttach) });
  // 承認済みが 1 つもなければ、判断の軸にしない。未検証だけは「前回の確かめ」として id を添える
  if (approved.length === 0) {
    const unverified = list.filter((k) => k.status === "未検証");
    return [unverified.length > 0 ? make(days, undefined, attach("unverified", unverified)) : make(days, undefined, tag)];
  }
  // 承認済みの知識を指摘に添えたら、食い違って使わないときも USED を出す（§14-3「どちらの polarity でも」。round-43 C-204）
  out.used.push(...approved.map((k) => k.id));
  if (allow.length > 0 && avoid.length > 0) return [make(days, undefined, attach("conflict", approved))];
  const lv = about.level ?? 0;
  if (lv < LOCAL_PAIR_MIN_LEVEL) return [make(days, undefined, attach("hint", approved))];
  if (avoid.length > 0) return [make(days, "G05.local_avoid", { ...attach("avoid", avoid), localNote: avoid.map((k) => k.conditionNote).join("／"), localIds: avoid.map((k) => k.id).join("・") })];
  // Lv.5 以上・承認済みの allow：押した日（同一月の表は請求）は出さない。押した事実が効くのは、知識が今も承認済みで rev が同じで、今の承認済みの間に押したとき（C-171・C-180）。
  // 「今の承認済みの間」は、時刻ではなく承認済みに入った回数で見る（時計が進まないと、承認し直しても status_since が同じになる。round-43 C-200）
  const dateOf = (d: number | undefined) => (d === undefined ? null : `${ym}-${String(d).padStart(2, "0")}`);
  const pressedBy = (d: number | undefined) =>
    allow.find((k) => {
      const p = about.pressed?.(localKey(k.id, k.rev, pair.a, pair.b), dateOf(d)) ?? null;
      return p !== null && p.round === k.round;
    });
  const left = days.filter((d) => {
    const k = pressedBy(d);
    if (k) out.silenced.push(k.id);
    return !k;
  });
  if (left.length === 0) return [];
  return [make(left, undefined, attach("allow", allow, left.flatMap((d) => (d === undefined ? [] : [dateOf(d)!]))))];
}

/** 例外の決まりを差し替えられる G05（テスト用。出荷は config/haihan-exceptions.json） */
export function makeG05(config: HaihanConfig = HAIHAN): GenericCheck {
  // 例外が 1 つも見つかっていない組（round-36 C-122：二重の死亡診断加算）は、そのことを一言にする
  const textOf = (ids: string[]) => (ids.length === 0 ? "この組の例外は、調べでは見つかっていません" : ids.map((id) => config.exceptions.find((x) => x.id === id)?.text ?? id).join("／"));
  return {
    id: "G05",
    kind: "背反",
    run(claim: GenericClaim, masters: MastersDb, about: GenericAbout) {
      const t = tensuhyoOf(masters, about);
      if (t === null) return noTensuhyo(about);
      const occ = occurrencesOf(claim);
      const rowsOf = masters.prepare("SELECT tani, code1, code2, kubun, tokurei, change, created_on, abolished_on FROM haihan WHERE snapshot = ? AND tani = ? AND code1 = ?");
      // 請求に両方ある組の行を、表と組ごとに 1 つ選ぶ
      const pairs = new Map<string, Row>();
      for (const code of occ.keys())
        for (const tani of [1, 2, 3, 4])
          for (const row of rowsOf.all(t.snapshot, tani, code) as Row[]) {
            if (row.code2 === code || !occ.has(row.code2) || !t.live(row)) continue;
            const key = `${tani}:${[row.code1, row.code2].sort().join(":")}`;
            if (!pairs.has(key) || row.code1 < row.code2) pairs.set(key, row);
          }
      const ctx: Ctx = {
        occ,
        comments: (claim.comments ?? []).map((x) => x.code),
        outpatient: (about as GenericAboutMore).outpatient,
        yearMonth: about.yearMonth,
        answers: about.answers,
        facts: about.facts,
        selects: selectorOf(masters, about),
      };
      const out: GenericFinding[] = [];
      const silenced: string[] = [];
      const local = { used: [] as string[], silenced: [] as string[] };
      // 上限（FINDING_LIMIT）に達したら、指摘を作らずに数えるだけにする（組で増える。round-32 S-9）
      let more = 0;
      const push = (f: GenericFinding) => {
        if (out.length >= (about.findingLimit ?? FINDING_LIMIT)) more++;
        else out.push(f);
      };
      for (const row of pairs.values()) {
        const [a, b] = [occ.get(row.code1)!, occ.get(row.code2)!];
        const marked = row.tokurei !== "0";
        let hit: { key: string; sure: boolean; units: number[]; days: number[]; params: Record<string, string> } | null = null;
        if (row.tani === 2) hit = { key: "month", sure: true, units: unitsOf(a, b), days: [], params: {} };
        else if (row.tani === 4) {
          const near = within7(a, b);
          if (near) hit = { key: "week", sure: false, units: unitsOf(a, b), days: [], params: { dayA: String(near[0]), dayB: String(near[1]) } };
        } else {
          const days = commonDays(a, b);
          const inB = new Set(b.units);
          const shared = a.units.filter((u) => inB.has(u));
          if (row.tani === 3 && shared.length > 0) hit = { key: "same_unit", sure: true, units: shared, days, params: {} };
          else if (days.length > 0) hit = { key: row.tani === 1 ? "day" : "same_day", sure: row.tani === 1, units: unitsOf(a, b), days, params: { days: daysText(days) } };
        }
        if (hit === null) continue;
        const keep = row.kubun === "1" ? row.code1 : row.kubun === "2" ? row.code2 : "いずれか一方";
        let cur = hit;
        const base = (messageKey: string, certainty: "確定" | "条件つき", params: Record<string, string>): GenericFinding => ({
          check: "G05",
          kind: "背反",
          certainty,
          units: cur.units,
          codes: [row.code1, row.code2],
          messageKey,
          params: { a: row.code1, b: row.code2, keep, ...cur.params, ...params },
          source: { data: TABLE.haihan[row.tani], ref: `診療行為コード①=${row.code1}, 診療行為コード②=${row.code2}` },
        });
        const matched = marked && row.tani !== 4 ? patternOf(config, row, ctx.selects) : null;
        if (matched === null) {
          const key = `G05.${hit.key}${marked ? "_cond" : ""}`;
          const certainty = hit.sure && !marked && !t.weak(row) ? "確定" : "条件つき";
          if (!marked || row.tani === 4) {
            push(base(key, certainty, {}));
            continue;
          }
          // (i) 特例条件の行で、どの組（HP）にも当たらない → 院内の知識を添える（design.md §14-3）。残った日の指摘にするときは、その日の単位と日だけにする
          const h0 = hit;
          const slots: (number | undefined)[] = row.tani === 2 || h0.days.length === 0 ? [undefined] : h0.days;
          const make = (ds: (number | undefined)[], messageKey?: string, params: Record<string, string> = {}) => {
            const nums = ds.filter((d): d is number => d !== undefined);
            const sub = nums.length === h0.days.length || nums.length === 0 ? h0 : { ...h0, days: nums, units: h0.units.filter((u) => nums.some((d) => ((claim as TimedClaim).units[u].days?.[d - 1] ?? 0) > 0)), params: h0.key === "same_unit" ? h0.params : { days: daysText(nums) } };
            cur = sub;
            const where = row.tani === 2 ? "同じレセプト" : sub.key === "same_unit" ? "同じ算定単位" : sub.key === "same_day" ? `別の算定単位ですが、同じ日（${daysText(sub.days)}日）` : `同じ日（${daysText(sub.days)}日）`;
            return base(messageKey ?? key, certainty, messageKey ? { where, ...params } : params);
          };
          for (const f of withLocal(about, ctx.yearMonth, row, slots, make, local)) push(f);
          continue;
        }
        const { p, aCode } = matched;
        // 同時の表は、同じ算定単位かを算定日ごとに照らす（§13-4 (a)。round-38 X-110）：その日に両方のある単位がある日（言い切りの候補）と、ない日（別の単位で同じ日）に分け、
        // 分けたそれぞれで、その日の単位だけを当たる単位にする。別の日の同じ単位を、残った日の判定に使わない
        const unitsOn = (d: number, pick: (u: number) => boolean) => [...new Set([...a.units, ...b.units])].filter((u) => pick(u) && ((claim as TimedClaim).units[u].days?.[d - 1] ?? 0) > 0).sort((x, y) => x - y);
        const inA = new Set(a.units);
        const both = (u: number) => inA.has(u) && b.units.includes(u);
        const buckets: { h: NonNullable<typeof hit>; days: number[] }[] =
          row.tani === 3 && hit.days.length > 0
            ? [
                { days: hit.days.filter((d) => unitsOn(d, both).length > 0), key: "same_unit", sure: true },
                { days: hit.days.filter((d) => unitsOn(d, both).length === 0), key: "same_day", sure: false },
              ].filter((x) => x.days.length > 0).map((x) => ({ days: x.days, h: { key: x.key, sure: x.sure, days: x.days, units: [...new Set(x.days.flatMap((d) => unitsOn(d, x.key === "same_unit" ? both : () => true)))].sort((m, n) => m - n), params: (x.key === "same_unit" ? {} : { days: daysText(x.days) }) as Record<string, string> } }))
            : [{ h: hit, days: hit.days }];
        for (const bucket of buckets) {
          cur = bucket.h;
          const hit2 = cur;
          // 例外の判定の単位：1 日の表・同時の表は算定日ごと（算定日がなければ 1 つ）、同一月の表はレセプトごと（design.md §13-2）
          const slots: (number | undefined)[] = row.tani === 2 || bucket.days.length === 0 ? [undefined] : bucket.days;
          const where = (days: (number | undefined)[]) => {
            const ds = days.filter((d): d is number => d !== undefined);
            return row.tani === 2 ? "同じレセプト" : hit2.key === "same_unit" ? `同じ算定単位${ds.length ? `（${daysText(ds)}日）` : ""}` : hit2.key === "same_day" ? `別の算定単位ですが、同じ日（${daysText(ds)}日）` : `同じ日（${daysText(ds)}日）`;
          };
          const dayParams = (days: (number | undefined)[]) => {
            const ds = days.filter((d): d is number => d !== undefined);
            return { where: where(days), ...(ds.length > 0 ? { days: daysText(ds) } : {}) };
          };
          const groups = { none: [] as { day: number | undefined; answered: boolean }[], open: [] as { day: number | undefined; o: Extract<SlotOutcome, { kind: "open" }> }[], require: new Map<string, { o: Extract<SlotOutcome, { kind: "require" }>; days: (number | undefined)[] }>() };
          for (const day of slots) {
            const o = outcomeOf(p, config, row, aCode, day, ctx);
            if (o.kind === "silent") silenced.push(...o.hx);
            else if (o.kind === "none") groups.none.push({ day, answered: o.answered });
            else if (o.kind === "open") groups.open.push({ day, o });
            else {
              const k = `${o.hx.map((x) => x.id).join(",")}|${o.checks.join("|")}|${o.comments.join(",")}`;
              const g = groups.require.get(k) ?? { o, days: [] };
              g.days.push(day);
              groups.require.set(k, g);
            }
          }
          for (const { o, days } of groups.require.values()) {
            const hx = o.hx.map((x) => x.id);
            const common = { hp: p.id, hx: hx.join("・"), hxText: textOf(hx), ...dayParams(days) };
            if (o.checks.length > 0) push(base("G05.exception_needs_check", "条件つき", { ...common, checks: o.checks.join("、") }));
            if (o.comments.length > 0) {
              // コメントと日の対応は取らず、件数で照らす（X-107）
              const have = ctx.comments.filter((code) => o.comments.includes(code)).length;
              if (have < days.length) push(base("G05.exception_needs_comment", "条件つき", { ...common, comments: o.comments.join("・"), need: String(days.length), have: String(have) }));
              else if (o.checks.length === 0) silenced.push(...hx);
            }
          }
          if (groups.none.length > 0) {
            const answered = groups.none.some((n) => n.answered);
            // receiptOnly：組の例外が全部 分類ア（レセプトで決まる）か。G11 が言い切りの形として隠すかを決める（C-280 の直し。2026-11-23 利用者の判断）
            const receiptOnly = p.exceptions.every((id) => config.exceptions.find((x) => x.id === id)?.kind === "receipt");
            push(base("G05.exception_none", hit2.sure && !t.weak(row) ? "確定" : "条件つき", { hp: p.id, hx: p.exceptions.join("・"), hxText: textOf(p.exceptions), answered: String(answered), receiptOnly: String(receiptOnly), because: answered ? "医療事務の答え（確かめた事実）で確かめたので、" : "レセプトで確かめたところ、", ...dayParams(groups.none.map((n) => n.day)) }));
          }
          if (groups.open.length > 0) {
            const days = groups.open.map((g) => g.day);
            const asks = groups.open.flatMap((g) => g.o.asks);
            const split = groups.open.find((g) => g.o.split)?.o.split;
            // 問いを出すのは、答えを読める点検（取り込んだレセプトの点検）だけ（L-76）
            if (about.answers && asks.length > 0) {
              const hx = [...new Set(asks.map((x) => x.hx))];
              push(base("G05.exception_ask", "条件つき", { hp: p.id, hx: hx.join("・"), hxText: textOf(hx), asks: JSON.stringify(asks), ...dayParams(days) }));
            } else if (asks.length === 0) {
              // (ii) 未決の問いがなく「決まらない」（日で分かれた・その他・判定不能・ウの例外）→ 院内の知識を添える（design.md §14-3。X-123）。残った日の指摘にするときは、その日の単位だけにする
              const hx = [...new Set(groups.open.flatMap((g) => g.o.hx))];
              const unitsBefore = cur.units;
              const make = (ds: (number | undefined)[], messageKey?: string, params: Record<string, string> = {}) => {
                const nums = ds.filter((d): d is number => d !== undefined);
                cur = { ...hit2, units: nums.length === 0 || nums.length === days.length ? unitsBefore : unitsBefore.filter((u) => nums.some((d) => ((claim as TimedClaim).units[u].days?.[d - 1] ?? 0) > 0)) };
                const own: { messageKey: string; params: Record<string, string> } = split
                  ? { messageKey: "G05.exception_split", params: { hp: p.id, hx: split.hx, hxText: textOf([split.hx]), hitDays: shortDays(split.hit), missDays: shortDays(split.miss) } }
                  : { messageKey: "G05.exception_check", params: { hp: p.id, hx: hx.join("・"), hxText: textOf(hx), questions: "例外に当たるかは、レセプトとこれまでの答えでは決まりません。告示・通知を確かめてください" } };
                return base(messageKey ?? own.messageKey, "条件つき", { ...own.params, ...dayParams(ds), ...params });
              };
              for (const f of withLocal(about, ctx.yearMonth, row, days, make, local)) push(f);
            } else {
              // 答えを渡さない経路（月末の点検・算定プレビュー・試算・measure-generic）と、問いの残っていない「決まらない」は、選択肢を出さず、
              // 何を確かめればよいか（例外の一言と問いの文）を挙げた条件つきの文にする（利用者の判断 2026-11-22。選択肢は出さない：L-76）
              const hx = [...new Set(groups.open.flatMap((g) => g.o.hx))];
              const questions = [...new Set(asks.map((x) => (x.key === "sameDaySeparate" ? FACT_LABEL.sameDaySeparate : (config.exceptions.find((e) => e.id === x.hx)?.ask?.question ?? ""))))].filter((q) => q !== "");
              push(base("G05.exception_check", "条件つき", { hp: p.id, hx: hx.join("・"), hxText: textOf(hx), questions: questions.length > 0 ? `医療事務に確かめること：${questions.map((q) => `「${q}」`).join("／")}` : "例外に当たるかは、レセプトとこれまでの答えでは決まりません。告示・通知を確かめてください", ...dayParams(days) }));
            }
          }
        }
      }
      return Object.assign(out, { more, silenced, ...(local.silenced.length > 0 ? { localSilenced: local.silenced } : {}), ...(local.used.length > 0 ? { localUsed: [...new Set(local.used)] } : {}) });
    },
  };
}

export const g05: GenericCheck = makeG05();
