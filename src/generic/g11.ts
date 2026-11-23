// G11 取り忘れ（design.md §15-8。FR-194）：本人が確かめたカルテの「行ったこと」（当てたコードつき）と請求を突き合わせ、カルテにあって請求にないものを言う。
// 判定は決まった規則だけで行い、LLM は使わない。指摘はいつも条件つき（言い切りの一覧に載っても上げない。L-101）で、宛先は医療事務。点数・金額は出さない。
// 算定できないものは 4 つの手順で決める（2026-11-22 の単純化）：
//   1. 1 つずつ見る：元の請求＋候補 1 つで、データの点検（G03〜G06・G10）の言い切りの形の抑えが候補に結び付けば隠す。条件つきの抑えは添え書き（C-280）
//   2. まとめて 1 回：通った候補を全部足し、候補どうしの包括・背反だけを見る。隠さず添え書き。背反区分 3 の組は 1 件の missing_either（L-113）
//   3. 手書きのルールを 1 回：呼び出し側が渡す step3（R18 と、取り込んだ請求では担当のルール。src/generic/g11-rules.ts）。指摘は添え書きにするだけで、隠さない
//   4. 出す：コードごとに 1 件で日の一覧を持つ（C-281）。添え書きのある日を持つ件は「注意つき」として後ろにまとめる
// g11Owned の区分（R ルールと導出が見る区分）は、算定プレビューでは見ず、取り込んだ請求では見る（L-97 を v30 で改める。段 18c）。
// 取り込んだ請求では、R ルールと 2 回言わない（R03・R14 の取り忘れと同じ区分は言わない。R01 の回数の区分誤りには、取り忘れを先に確かめる文を返す）
import { kubunOfCode } from "../engine/revisions/codes";
import { derivedKubun, g11Owned } from "../engine/derive";
import type { Revision } from "../engine/revisions/types";
import type { ChartAct, RxChoice } from "../chart/acts";
import { checkReady, hasUnitColumns, iyakuhinOf, pickSnapshot, shinryoOf, tokuteiOf, unitCaseCollisions, type MastersDb } from "../masters/db";
import { g03 } from "./g03";
import { g04 } from "./g04";
import { g05 } from "./g05";
import { g10, g10Blocking } from "./g10";
import type { Finding } from "../engine/types";
import { KIJUN_OWNERS } from "../facility/codes";
import { tensuhyoOf, type Dated } from "./tensuhyo";
import type { GenericAbout, GenericAboutMore, GenericCheck, GenericCheckId, GenericFinding } from "./types";

// ───────────────────────────────────────────────────────────────────────────
// 入力

/** 本人が確かめた行為 1 つ（カルテの日付と、その日の記載の id） */
export type ConfirmedAct = { date: string; noteId?: number; act: ChartAct };
/** その日の処方の記載があるか（rx）と、本人が選んだ（なければ初期値の規則で出た）院内・院外 */
export type RxDay = { date: string; rx: boolean; choice: RxChoice | null };
/** 院内処方か院外処方か（施設の申告 dispensing。その請求の診療年月で効く行）。inside＝院内処方もある */
export type Dispensing = "outside" | "inside" | "unknown";

/** 突き合わせる請求の行（UKE の単位をそのまま渡せる。算定プレビューは claimOfLines の単位） */
export type G11Item = { kind: "SI" | "IY" | "TO"; code: string; quantity?: string };
export type G11Unit = { items: G11Item[]; count?: number; days?: number[] };
export type G11Claim = { units: G11Unit[] };

export type G11About = GenericAboutMore & {
  acts?: ConfirmedAct[];
  rxDays?: RxDay[];
  /** どの経路の請求か（design.md §15-8）。uke＝取り込んだ請求、preview＝導出の算定行 */
  path: "uke" | "preview";
  dispensing: Dispensing;
};

/** 足した単位 1 つ（候補の単位。算定日は 1 日） */
type AddedUnit = { items: G11Item[]; count: number; days: number[]; day: number };

/** 手順 3（手書きのルール）：候補 → その候補の足した単位。戻りは候補ごとの添え書きと、点検の範囲に足す文 */
export type Step3 = (cands: { id: number; date: string; units: { items: G11Item[]; count: number }[] }[]) => { notes: Map<number, Note[]>; scope: string[] };
/**
 * 手順 1 の同じ族の例外（design.md §15-8 の「施設基準の扱い」。L-128）：元の請求＋候補 1 つに R18 を掛け、候補の区分を同じ族の区分に直す区分誤りが出れば、その添え書き。
 * 出なければ null（呼び出し側：src/generic/g11-rules.ts）
 */
export type SameFamily = (cand: { date: string; units: { items: G11Item[]; count: number }[] }) => Note | null;

/** 添え書きの理由（注意つきの数を理由ごとに数える。design.md §15-8 の「注意つきの候補の出し方」） */
export const CAUTION_REASONS = ["データの点検の条件つきの違反", "候補どうしの包括・背反", "同じ族の区分誤り", "情報不足", "手書きのルールの指摘", "手書きのルールで判定できない行", "施設基準の申告が分からない"] as const;
export type CautionReason = (typeof CAUTION_REASONS)[number];
/** rule：添え書きの元の手書きのルール。doubt：同じ族の区分誤り（R18 のときだけ、前に選んだ対応を消す。C-263） */
export type Note = { reason: CautionReason; text: string; rule?: string; doubt?: boolean };

// ───────────────────────────────────────────────────────────────────────────
// 出力

export type G11Kind = "G11.missing" | "G11.missing_with" | "G11.missing_either" | "G11.missing_derived" | "G11.quantity_less" | "G11.quantity_more";
export type G11Day = { date: string; quote: string; notes: Note[] };
export type G11Finding = {
  messageKey: G11Kind;
  certainty: "条件つき";
  /** 指摘のコード（missing_either は 2 つ） */
  codes: string[];
  text: string;
  days: G11Day[];
  /** 添え書きのある日を 1 つでも持つ（後ろにまとめる） */
  caution: boolean;
  source: { data: "chart"; ref: string };
};
/** 言わなかった候補（L-96）：書かれた名前・日・理由（抑えた点検の名前と相手の行の名前） */
export type G11Hidden = { written: string; date: string; reason: string; check: GenericCheckId; partner: string; with?: string[] };
/** 区分誤りの出た対応（C-250・C-263）：R18 の同じ族の区分誤りが添えられた候補の、書かれた名前・表・コード。呼び出し側が前に選んだ対応から消す */
export type KubunDoubt = { written: string; tbl: string; code: string };
export type G11Result =
  | { skip: string }
  | {
      findings: G11Finding[];
      hidden: G11Hidden[];
      kubunDoubts: KubunDoubt[];
      /** 手書きのルールの指摘に添える文（R01 の回数の区分誤り。条件つきに下げる。design.md §15-8 の「R ルールと 2 回言わない」） */
      handNotes: { messageKey: string; text: string }[];
      /** 院内・院外が選ばれていない日の案内（たたまない 1 行。C-243）。なければ null */
      guide: string | null;
      /** 点検の範囲（見ていないもの・言わなかった数・注意つきの数） */
      scope: string[];
      /** 段の報告に出す数（design.md §15-10 の共通の検査の G11 の数） */
      counts: { acts: number; unmatched: number; notSeen: number; hidden: Record<string, number>; caution: Partial<Record<CautionReason, number>>; byKind: Partial<Record<G11Kind, number>> };
    };

// ───────────────────────────────────────────────────────────────────────────
// 定数（設計の値・EM の採用値）

/** 判断料の候補の元にする検査のグループ（EM §2-11 の V-9：1〜6・17。8 の基本的検体検査判断料は入れない） */
export const JUDGEMENT_GROUPS: readonly number[] = [1, 2, 3, 4, 5, 6, 17];
/** 剤形（医薬品マスター）：1＝内服、6＝外用。ほかは投薬の組に入れない（L-111） */
const ORAL = "1";
const EXTERNAL = "6";
/** 剤形から決まる調剤料と、処方料（その他）（EM §2-8 の K8〜K11 の別表のコード） */
export const AUTO_CODES = { oral: "120000710", external: "120001010", shohoryo: "120001210" } as const;

const CHECK_NAME: Record<string, string> = { G03: "行の属性", G04: "包括", G05: "背反", G06: "回数", G10: "施設基準" };

const md = (date: string) => String(Number(date.slice(8, 10)));
const daysText = (dates: string[]) => [...new Set(dates)].sort().map(md).join("・");
const zeros = () => Array.from({ length: 31 }, () => 0);
const unitOn = (items: G11Item[], day: number, count = 1): AddedUnit => {
  const days = zeros();
  days[day - 1] = count;
  return { items, count, days, day };
};
const squash = (s: string) => s.normalize("NFKC").replace(/\s/g, "");

// ───────────────────────────────────────────────────────────────────────────
// 候補

type Report = { code: string; written: string; quote: string; noteId?: number; name: string; tbl?: string };
type Cand = {
  id: number;
  kind: "act" | "with" | "drugs" | "derived" | "qty";
  date: string;
  day: number;
  units: AddedUnit[];
  /** 指摘に出す行為（組は、カルテにあって請求にないもの） */
  report: Report[];
  /** with：親の書かれた名前／derived：何から決まったか（文）／qty：量の指摘 */
  parent?: string;
  /** act：組ごと隠したときに言わなかった一覧に添える、手技で使った薬・器材の書かれた名前（with） */
  withNames?: string[];
  derived?: { what: string; basis: string; name: string };
  qty?: { key: "G11.quantity_less" | "G11.quantity_more"; chart: string; claim: string; child?: string };
  /** 手順 1〜3 の添え書き */
  notes: Note[];
};

/** 請求の中の、コードの日ごとの回数（SI・IY・TO）と、量の合計（日ごと） */
type Index = { days: Map<string, number[]>; untimed: Set<string>; qty: Map<string, number[]> };
function indexOf(claim: G11Claim): Index {
  const out: Index = { days: new Map(), untimed: new Set(), qty: new Map() };
  for (const u of claim.units) {
    const timed = u.days !== undefined && u.days.some((n) => n > 0);
    for (const it of u.items) {
      if (!timed) {
        out.untimed.add(it.code);
        continue;
      }
      const d = out.days.get(it.code) ?? zeros();
      const q = out.qty.get(it.code) ?? zeros();
      u.days!.slice(0, 31).forEach((n, i) => {
        d[i] += n;
        const v = Number((it.quantity ?? "").trim());
        if (n > 0 && it.quantity !== undefined && it.quantity.trim() !== "" && Number.isFinite(v)) q[i] += v * n;
      });
      out.days.set(it.code, d);
      out.qty.set(it.code, q);
    }
  }
  return out;
}

/**
 * 判定に使う 4 つのもの：区分の同じコード（版の accept）・g11Owned・C〜I に回した区分・処方箋料の区分のコード。
 * 区分に当たらないコードは、そのコードだけが「同じ」
 */
function revInfo(rev: Revision) {
  const owned = new Set(g11Owned(rev.consts));
  const derived = new Set(derivedKubun(rev.consts));
  const deferred = new Set(rev.consts.deferred ?? []);
  const codesOf = (kubun: string) => (Object.hasOwn(rev.codes, kubun) ? [rev.codes[kubun].primary, ...rev.codes[kubun].accept] : []);
  const same = (code: string): string[] => {
    const k = kubunOfCode(rev, code);
    return k ? codesOf(k) : [code];
  };
  const rxCodes = new Set([rev.consts.rx.many, rev.consts.rx.other].flatMap(codesOf));
  return { owned, derived, deferred, same, rxCodes, rxPrimary: Object.hasOwn(rev.codes, rev.consts.rx.other) ? rev.codes[rev.consts.rx.other].primary : null, kubunOf: (code: string) => kubunOfCode(rev, code) };
}

// ───────────────────────────────────────────────────────────────────────────
// 量（design.md §15-8 の「同じ日の回数・量の違い」。L-98・C-253・C-261・C-262・X-144・X-146）

/** カルテの量の文字を「数＋単位」だけのときに読む（NFKC のあと）。読めなければ null */
export function readQuantity(q: string): { n: number; unit: string } | null {
  const m = /^(\d+(?:\.\d+)?)(\D+)$/.exec(squash(q));
  return m ? { n: Number(m[1]), unit: m[2] } : null;
}

/** 単位の名前どうしの比べ方：NFKC・空白を除き、衝突する名前でなければ英字の大文字・小文字をそろえる（L-98 を v30 で改める） */
export function unitKey(name: string, collide: ReadonlySet<string>): string {
  const n = squash(name);
  return collide.has(n) ? n : n.toLowerCase();
}

// ───────────────────────────────────────────────────────────────────────────
// 抑え（手順 1・2）。足した単位に結び付いた違反を、点検の上限を掛けずに全部見る（X-138）

type Bind = { check: GenericCheckId; certain: boolean; partner: string; why: string; byDeclaration?: string; exception?: { hxText: string; month: boolean }; kijunCodes?: string };

/** 指摘が参照する単位に、足した単位が入るか。日で決まる指摘は、その日が足した単位の算定日か（X-137） */
function touches(f: GenericFinding, added: Map<number, AddedUnit>, code: string): AddedUnit[] {
  const days = (f.params.days ?? "").split("・").filter(Boolean).map(Number);
  return f.units.flatMap((u) => {
    const a = added.get(u);
    if (!a || !a.items.some((it) => it.code === code)) return [];
    if (days.length > 0 && !days.includes(a.day)) return [];
    return [a];
  });
}

/** 指摘 1 件のうち、算定できない側（X-140）。包括は含まれる側、背反の区分 1・2 は表が算定しない側。区分 3 は null（どちらか一方） */
function loserOf(f: GenericFinding): { loser: string; partner: string } | null {
  if (f.check === "G04") return { loser: f.codes[1], partner: f.codes[0] };
  if (f.check === "G05") {
    const keep = f.params.keep;
    if (keep !== f.codes[0] && keep !== f.codes[1]) return null;
    return keep === f.codes[0] ? { loser: f.codes[1], partner: f.codes[0] } : { loser: f.codes[0], partner: f.codes[1] };
  }
  return { loser: f.codes[0], partner: f.codes[0] };
}

/**
 * 言い切りの形（§12-3 の「確定に上げる条件」の形。言い切りの一覧には依らない。C-280）。背反の特例条件の例外で決めた指摘は条件つきとして扱う。
 * ただし、例外が全部 分類ア（レセプトで決まる）で、元の請求から「当たらない」と決まった組（答えを使っていない exception_none）は言い切りの形に入れる
 * （C-280 の直し。2026-11-23 利用者の判断。reviews/fable-consult-18b.md の推奨 1）
 */
const receiptNone = (f: GenericFinding) => f.messageKey === "G05.exception_none" && f.params.receiptOnly === "true" && f.params.answered === "false";
const certainShape = (f: GenericFinding) => f.certainty === "確定" && (receiptNone(f) || (!f.messageKey.startsWith("G05.exception") && !f.messageKey.startsWith("G05.local")));
/** 例外の決まりがあり、医療事務の答えが要る例外（分類イ・ウ）が決まっていない背反の組（添え書きに例外の一言を名指しする。C-280 の直し） */
const OPEN_EXCEPTION = new Set(["G05.exception_check", "G05.exception_ask", "G05.exception_split"]);
/** 条件つきの理由 */
function whyOf(f: GenericFinding): string {
  if (f.messageKey.endsWith("_cond") || f.messageKey.startsWith("G05.exception") || f.messageKey.startsWith("G05.local")) return "特例条件あり";
  if (f.messageKey === "G05.week" || f.messageKey.startsWith("G06.week")) return "1 週間の数え方";
  if (f.messageKey === "G05.same_day") return "別の単位の同時";
  if (f.messageKey.startsWith("G04.same") || f.messageKey.startsWith("G04.surgery")) return "同時・1 手術の単位";
  if (f.messageKey === "G06.master_limit") return "マスターの上限回数";
  return "診療年月より後のマスター";
}

type Ctx = { db: MastersDb; about: G11About; snapshot: { si: string; iy: string | null; to: string | null } };

const nameOfCode = (c: Ctx, code: string): string =>
  shinryoOf(c.db, c.snapshot.si, code)?.name ?? (c.snapshot.iy ? iyakuhinOf(c.db, c.snapshot.iy, code)?.name : undefined) ?? (c.snapshot.to ? tokuteiOf(c.db, c.snapshot.to, code)?.name : undefined) ?? code;

/** 回数（G06）：元の請求の単位だけで、その期間の上限に達しているときに、その期間の足した単位に結び付ける（X-140・L-114） */
function kaisuBinds(c: Ctx, idx: Index, a: AddedUnit, firstDow: number): Bind[] {
  const t = tensuhyoOf(c.db, c.about);
  if (!t) return [];
  const out: Bind[] = [];
  const rows = c.db.prepare("SELECT unit_code, limit_count, tokurei, change, created_on, abolished_on FROM kaisu WHERE snapshot = ? AND code = ?");
  for (const it of a.items) {
    if (it.kind !== "SI" || a.count <= 0) continue;
    const days = idx.days.get(it.code) ?? zeros();
    const month = days.reduce((s, n) => s + n, 0) + (idx.untimed.has(it.code) ? 1 : 0);
    const week = Math.floor((a.day - 1 + firstDow) / 7);
    const inWeek = days.reduce((s, n, i) => (Math.floor((i + firstDow) / 7) === week ? s + n : s), 0);
    const name = nameOfCode(c, it.code);
    for (const r of rows.all(t.snapshot, it.code) as (Dated & { unit_code: number; limit_count: number; tokurei: string })[]) {
      if (!t.live(r) || r.limit_count <= 0) continue;
      const sure = r.tokurei === "0" && !t.weak(r);
      if (r.unit_code === 121 && days[a.day - 1] >= r.limit_count) out.push({ check: "G06", certain: sure, partner: name, why: sure ? "" : "特例条件あり" });
      else if (r.unit_code === 131 && month >= r.limit_count) out.push({ check: "G06", certain: sure, partner: name, why: sure ? "" : "特例条件あり" });
      else if (r.unit_code === 138 && inWeek >= r.limit_count) out.push({ check: "G06", certain: false, partner: name, why: r.tokurei === "0" ? "1 週間の数え方" : "特例条件あり" });
    }
  }
  return out;
}

/** 元の請求＋足した単位で点検を掛け、足した単位（算定できない側）に結び付いた違反を返す。onlyAmong を渡すと、相手がその単位のもの（手順 2）だけ */
function bindsOf(c: Ctx, checks: GenericCheck[], claim: G11Claim, addedList: { cand: number; unit: AddedUnit }[]): Map<number, (Bind & { partnerUnit?: number })[]> {
  const base = claim.units.length;
  const units = [...claim.units, ...addedList.map((x) => x.unit)];
  const added = new Map(addedList.map((x, i) => [base + i, x.unit]));
  const candOf = new Map(addedList.map((x, i) => [base + i, x.cand]));
  const about: GenericAbout = { ...c.about, findingLimit: Number.POSITIVE_INFINITY };
  const out = new Map<number, (Bind & { partnerUnit?: number })[]>();
  const push = (cand: number, b: Bind & { partnerUnit?: number }) => out.set(cand, [...(out.get(cand) ?? []), b]);
  for (const check of checks) {
    // 施設基準は内部の入口（R12・R18 に譲る前の結果。L-128）
    const found = check.id === "G10" ? g10Blocking({ units }, c.db, about, [...added.keys()]) : check.run({ units }, c.db, about);
    if (!Array.isArray(found)) continue;
    for (const f of found) {
      if (f.check === "G10" && f.messageKey !== "G10.not_held" && f.messageKey !== "G10.unknown") continue;
      const lp = loserOf(f);
      if (!lp) continue;
      for (const a of touches(f, added, lp.loser)) {
        const u = [...added].find(([, v]) => v === a)![0];
        // 相手の単位（手順 2 で、相手が別の候補かを決める）：相手のコードを持つ足した単位
        const partnerUnit = [...added].find(([k, v]) => k !== u && v.items.some((it) => it.code === lp.partner) && f.units.includes(k))?.[0];
        const b: Bind & { partnerUnit?: number } = {
          check: f.check,
          certain: f.check === "G10" ? f.messageKey === "G10.not_held" : certainShape(f),
          partner: f.check === "G10" ? (f.params.kijun ?? "") : nameOfCode(c, lp.partner),
          why: whyOf(f),
          ...(f.check === "G10" && f.messageKey === "G10.unknown" ? { byDeclaration: f.params.kijun ?? "" } : {}),
          ...(f.check === "G10" && f.params.kijunCodes ? { kijunCodes: f.params.kijunCodes } : {}),
          ...(OPEN_EXCEPTION.has(f.messageKey) && f.params.hxText ? { exception: { hxText: f.params.hxText, month: f.params.where === "同じレセプト" } } : {}),
          ...(partnerUnit !== undefined ? { partnerUnit } : {}),
        };
        push(candOf.get(u)!, b);
      }
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 本体

/**
 * checks は手順 1・2 で掛けるデータの点検（テストが作り物を入れる。出荷は G03・G04・G05・G10。回数〔G06〕は kaisuBinds が電子点数表から直接見る）。
 * step3 は手書きのルール（段 18b は R18 だけ。渡さなければ掛けない）
 */
export function evaluateG11(claim: G11Claim, db: MastersDb | null, about: G11About, rev: Revision, opt: { checks?: GenericCheck[]; step3?: Step3; sameFamily?: SameFamily; hand?: Finding[] } = {}): G11Result {
  const acts = (about.acts ?? []).filter((a) => a.date.startsWith(`${about.yearMonth}-`));
  if (acts.length === 0) return { skip: "確かめたカルテの「行ったこと」がないので、取り忘れは見ていません" };
  if (!db) return { skip: "基本マスターがないので、取り忘れは見ていません" };
  // G11 が頼る点検（G03〜G06・G10）が判定不能なら、その請求の取り忘れは何も言わない（X-131・X-136）
  for (const [id, label] of [["G11", "取り忘れ"], ["G03", "行の属性"], ["G04", "包括"], ["G05", "背反"], ["G06", "回数"], ["G10", "施設基準"]] as const) {
    const ready = checkReady(db, id);
    if (!ready?.ready) return { skip: `${id}（${label}）が動いていないので、算定できるかを確かめられず、取り忘れは見ていません` };
  }
  if (!about.declaration) return { skip: "G10（施設基準）が動いていないので、算定できるかを確かめられず、取り忘れは見ていません" };
  const si = pickSnapshot(db, "shinryo", about.yearMonth, about.generation);
  if (!si || !tensuhyoOf(db, about)) return { skip: `診療年月の世代（${about.generation}）のマスターがないので、取り忘れは見ていません` };
  const c: Ctx = { db, about, snapshot: { si: si.snapshot, iy: pickSnapshot(db, "iyakuhin", about.yearMonth, about.generation)?.snapshot ?? null, to: pickSnapshot(db, "tokutei", about.yearMonth, about.generation)?.snapshot ?? null } };
  const checks = opt.checks ?? [g03, g04, g05, g10];
  const info = revInfo(rev);
  const idx = indexOf(claim);
  const firstDow = new Date(`${about.yearMonth}-01T00:00:00Z`).getUTCDay();

  /** そのコードが請求にあるか：算定日の分かる単位はその日、分からない単位は月の中。版の accept で同じ区分のコードは同じ。monthly＝月の中で見る（判断料） */
  const present = (code: string, day: number, monthly = false) =>
    info.same(code).some((x) => idx.untimed.has(x) || (monthly ? (idx.days.get(x) ?? []).some((n) => n > 0) : (idx.days.get(x)?.[day - 1] ?? 0) > 0));
  const rxPresent = (day: number) => [...info.rxCodes].some((x) => (idx.days.get(x)?.[day - 1] ?? 0) > 0 || idx.untimed.has(x));
  const isJudgement = (code: string) => shinryoOf(db, c.snapshot.si, code)?.kensa_kind === "2";

  const scope: string[] = [];
  const counts = { notSeen: 0 };
  /** 点検の範囲の数（文 → 数）。suffix は数のあとに添える案内 */
  const scopeCount = new Map<string, { n: number; suffix: string }>();
  const tally = (text: string, n = 1, suffix = "") => scopeCount.set(text, { n: (scopeCount.get(text)?.n ?? 0) + n, suffix });
  const UNKNOWN_DISPENSING = ["院内か院外かが分からないので薬は見ていません", "。施設の申告で院内・院外処方を入れてください"] as const;

  const rxDay = new Map((about.rxDays ?? []).map((r) => [r.date, r]));
  const undecidedDays = new Set<string>();
  const cands: Cand[] = [];
  let nextId = 0;
  const add = (x: Omit<Cand, "id" | "notes">) => cands.push({ ...x, id: nextId++, notes: [] });

  /** 量の比較の材料：単位の列・衝突する単位の名前・1 日の上限の行 */
  const units = hasUnitColumns(db);
  const collide = new Set(units ? unitCaseCollisions(db).flat().map(squash) : []);
  const t = tensuhyoOf(db, about)!;
  const dayLimit = (code: string): number | null => {
    const rows = db.prepare("SELECT unit_code, limit_count, change, created_on, abolished_on FROM kaisu WHERE snapshot = ? AND code = ? AND unit_code = 121").all(t.snapshot, code) as (Dated & { limit_count: number })[];
    const live = rows.filter((r) => t.live(r) && r.limit_count > 0);
    return live.length > 0 ? Math.min(...live.map((r) => r.limit_count)) : null;
  };
  const masterUnit = (kind: G11Item["kind"], code: string): string | null => {
    if (kind === "SI") {
      const r = shinryoOf(db, c.snapshot.si, code);
      return r && r.unit_code !== 0 && r.unit_name !== "" ? r.unit_name : null;
    }
    const r = kind === "IY" ? (c.snapshot.iy ? iyakuhinOf(db, c.snapshot.iy, code) : null) : c.snapshot.to ? tokuteiOf(db, c.snapshot.to, code) : null;
    return r && r.unit_name !== "" ? r.unit_name : null;
  };
  const notQty = (why: string) => tally(`量は見ていません（${why}）`);

  /**
   * その日・その区分のカルテの量（同じ日・同じ区分の行を合計。X-146）と請求の量を比べる。kind はマスターの表、child は子（「回」を比べない）。
   * 差があれば量の候補・指摘を足す
   */
  const compare = (kind: G11Item["kind"], code: string, date: string, quantities: (string | undefined)[], label: { written: string; child?: string; quote: string; noteIds: (number | undefined)[] }) => {
    if (quantities.every((q) => q === undefined || q.trim() === "")) return;
    if (!units) return notQty("単位の列が古い形です");
    const read = quantities.map((q) => (q === undefined ? null : readQuantity(q)));
    if (read.some((r) => r === null)) return notQty(quantities.length > 1 ? "同じ日の記載の量がそろっていない" : "決まった形で書かれていない");
    const us = new Set(read.map((r) => squash(r!.unit)));
    if (us.size > 1) return notQty("同じ日の記載の量がそろっていない");
    const n = read.reduce((s, r) => s + r!.n, 0);
    const unit = read[0]!.unit;
    const day = Number(date.slice(8, 10));
    const mu = masterUnit(kind, code);
    const claimDays = (x: string) => info.same(x).reduce((s, y) => s + (idx.days.get(y)?.[day - 1] ?? 0), 0);
    const claimQty = (x: string) => info.same(x).reduce((s, y) => s + (idx.qty.get(y)?.[day - 1] ?? 0), 0);
    const base = { date, day, report: label.noteIds.map((noteId) => ({ code, written: label.written, quote: label.quote, noteId, name: nameOfCode(c, code) })) };
    if (mu !== null && unitKey(unit, collide) === unitKey(mu, collide)) {
      const have = claimQty(code);
      if (n > have) add({ ...base, kind: "qty", units: [{ items: [{ kind, code, quantity: String(n - have) }], count: 0, days: zeros(), day }], qty: { key: "G11.quantity_less", chart: `${n}${unit}`, claim: String(have), child: label.child } });
      else if (n < have) add({ ...base, kind: "qty", units: [], qty: { key: "G11.quantity_more", chart: `${n}${unit}`, claim: String(have), child: label.child } });
      return;
    }
    if (squash(unit) === "回" && !label.child) {
      const limit = dayLimit(code);
      if (limit === null) return notQty("1 日の回数の決まりがデータにない");
      const have = claimDays(code);
      if (n > limit) tally("カルテの回数が 1 日の上限を超えています");
      const capped = Math.min(n, limit);
      const chart = n > limit ? `${n}回（1 日に算定できるのは ${limit} 回まで）` : `${n}回`;
      if (capped > have) add({ ...base, kind: "qty", units: [unitOn([{ kind, code }], day, capped - have)], qty: { key: "G11.quantity_less", chart, claim: `${have}回` } });
      else if (n < have) add({ ...base, kind: "qty", units: [], qty: { key: "G11.quantity_more", chart, claim: `${have}回` } });
      return;
    }
    if (squash(unit) === "回") return; // 子の「回」は親の回数と同じものなので比べない
    if (mu === null) return notQty("この行為はマスターに量の単位がない");
    return notQty(`単位がマスターと合わない（マスターは ${mu}）`);
  };

  // 1. カルテの行為を、見ないもの・投薬・ほかに分ける
  const byDay = new Map<string, ConfirmedAct[]>();
  for (const a of acts) byDay.set(a.date, [...(byDay.get(a.date) ?? []), a]);
  let unmatched = 0;
  for (const [date, list] of [...byDay].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const day = Number(date.slice(8, 10));
    const r = rxDay.get(date);
    const drugs: ConfirmedAct[] = [];
    const procs: ConfirmedAct[] = [];
    // 同じ日・同じ区分の量を合計するため、先に集める
    const qtyGroups = new Map<string, { kind: G11Item["kind"]; code: string; acts: ConfirmedAct[] }>();
    for (const a of list) {
      const m = a.act.match;
      if (!m) {
        unmatched++;
        continue;
      }
      const kubun = m.tbl === "shinryo" ? info.kubunOf(m.code) : null;
      if (kubun && info.deferred.has(kubun)) {
        tally("在宅医療充実体制加算・在宅療養実績加算・在宅療養移行加算・注8 の減算は見ていません（C〜I の手順）");
        continue;
      }
      // 算定プレビューでは、導出が出来事から立てた行なので見ない（FR-99。C-230）。取り込んだ請求では見る（L-97 を v30 で改める）
      if (kubun && info.owned.has(kubun) && about.path === "preview") {
        counts.notSeen++;
        tally("訪問診療料・管理料など、R ルールと導出が見る区分は見ていません（算定プレビューでは導出と手書きのルールが見ます）");
        continue;
      }
      if (a.act.category === "投薬") {
        if (m.tbl === "iyakuhin") drugs.push(a);
        else if (m.tbl === "shinryo" && !info.rxCodes.has(m.code)) procs.push(a);
        else if (m.tbl === "shinryo") {
          // 処方箋料は、院内・院外の分け方に掛けない行為として見る（書かれた処方箋料。院内か院外かが分からない施設では見ない）
          if (about.dispensing === "unknown") tally(UNKNOWN_DISPENSING[0], 1, UNKNOWN_DISPENSING[1]);
          else regular(a, date, day, qtyGroups);
        }
        continue;
      }
      regular(a, date, day, qtyGroups);
    }
    for (const g of qtyGroups.values()) {
      const head = g.acts[0];
      compare(g.kind, g.code, date, g.acts.map((x) => x.act.quantity), { written: head.act.written, quote: [...new Set(g.acts.map((x) => x.act.quote))].sort().join("／"), noteIds: g.acts.map((x) => x.noteId) });
    }
    // 投薬の薬と手技（院内・院外の扱い。C-221・C-231・X-130）
    if (drugs.length + procs.length > 0) {
      const n = drugs.length + procs.length;
      if (about.dispensing === "outside") {
        if (drugs.length > 0) tally("院外処方の施設なので薬は見ていません", drugs.length);
        for (const p of procs) regular(p, date, day, new Map());
      } else if (about.dispensing === "unknown") tally(UNKNOWN_DISPENSING[0], n, UNKNOWN_DISPENSING[1]);
      else if (!r || !r.rx) tally(`${Number(date.slice(5, 7))}月${md(date)}日は処方の記載がないので薬は見ていません`, n);
      else if (r.choice === "outside") {
        if (drugs.length > 0) tally("院外処方箋の日なので薬は見ていません", drugs.length);
        for (const p of procs) regular(p, date, day, new Map());
      } else if (r.choice !== "inside") undecidedDays.add(date);
      else drugGroup(date, day, drugs, procs);
    }
  }

  /** 投薬でない行為（と、院外の日の投薬の手技）：請求にないなら候補、あれば with の子と量を見る */
  function regular(a: ConfirmedAct, date: string, day: number, qtyGroups: Map<string, { kind: G11Item["kind"]; code: string; acts: ConfirmedAct[] }>) {
    const m = a.act.match!;
    const kind: G11Item["kind"] = m.tbl === "shinryo" ? "SI" : m.tbl === "iyakuhin" ? "IY" : "TO";
    const children = (a.act.with ?? []).filter((x) => x.match);
    const rep = (code: string, written: string, quote: string, tbl?: string): Report => ({ code, written, quote, noteId: a.noteId, name: nameOfCode(c, code), ...(tbl ? { tbl } : {}) });
    if (!present(m.code, day, isJudgement(m.code))) {
      const items: G11Item[] = [{ kind, code: m.code }, ...children.map((x) => ({ kind: (x.match!.tbl === "iyakuhin" ? "IY" : "TO") as G11Item["kind"], code: x.match!.code }))];
      add({ kind: "act", date, day, units: [unitOn(items, day)], report: [rep(m.code, a.act.written, a.act.quote, m.tbl)], ...(children.length > 0 ? { withNames: children.map((x) => x.written) } : {}) });
      return;
    }
    // 請求にある：同じ日・同じ区分の量をまとめて比べる（X-146）
    const key = `${kind}|${info.same(m.code).sort().join(",")}`;
    const g = qtyGroups.get(key) ?? { kind, code: m.code, acts: [] };
    g.acts.push(a);
    qtyGroups.set(key, g);
    // 親が請求にあって子がないときだけ、子を言う（missing_with）。子の量は「回」以外を比べる
    for (const x of children) {
      const ck: G11Item["kind"] = x.match!.tbl === "iyakuhin" ? "IY" : "TO";
      if (!present(x.match!.code, day)) add({ kind: "with", date, day, units: [unitOn([{ kind: ck, code: x.match!.code }], day)], report: [rep(x.match!.code, x.written, x.quote)], parent: a.act.written });
      else compare(ck, x.match!.code, date, [x.quantity], { written: a.act.written, child: x.written, quote: x.quote, noteIds: [a.noteId] });
    }
  }

  /** 投薬の組（院内の日。X-130・C-221）：その日の薬・書かれた投薬の手技と、剤形から決まる調剤料・処方料を 1 つの候補にする */
  function drugGroup(date: string, day: number, drugs: ConfirmedAct[], procs: ConfirmedAct[]) {
    const kept: ConfirmedAct[] = [];
    const forms = new Set<string>();
    for (const d of drugs) {
      const z = c.snapshot.iy ? iyakuhinOf(db!, c.snapshot.iy, d.act.match!.code)?.zaikei : undefined;
      if (z !== ORAL && z !== EXTERNAL) {
        tally("剤形が内服・外用でない薬は見ていません");
        continue;
      }
      forms.add(z);
      kept.push(d);
    }
    const written = [...kept, ...procs];
    const missing = written.filter((a) => !present(a.act.match!.code, day));
    if (missing.length === 0) return;
    const auto = [...(forms.has(ORAL) ? [AUTO_CODES.oral] : []), ...(forms.has(EXTERNAL) ? [AUTO_CODES.external] : []), ...(forms.size > 0 ? [AUTO_CODES.shohoryo] : [])].filter(
      (code) => !present(code, day) && !written.some((a) => a.act.match!.code === code),
    );
    const unitsOfGroup: AddedUnit[] = [
      ...missing.map((a) => unitOn([{ kind: (a.act.match!.tbl === "iyakuhin" ? "IY" : "SI") as G11Item["kind"], code: a.act.match!.code }], day)),
      ...auto.map((code) => unitOn([{ kind: "SI", code }], day)),
    ];
    add({ kind: "drugs", date, day, units: unitsOfGroup, report: missing.map((a) => ({ code: a.act.match!.code, written: a.act.written, quote: a.act.quote, noteId: a.noteId, name: nameOfCode(c, a.act.match!.code) })) });
  }

  // 2. 決まった規則で足す候補（M-1。X-147）：判断料と処方箋料
  {
    const kensa = db.prepare("SELECT code FROM shinryo WHERE snapshot = ? AND kensa_kind = '2' AND kensa_group = ?");
    const groups = new Map<number, { acts: ConfirmedAct[] }>();
    for (const a of acts) {
      const m = a.act.match;
      if (!m || m.tbl !== "shinryo") continue;
      const r = shinryoOf(db, c.snapshot.si, m.code);
      if (!r || r.kensa_kind !== "1" || !JUDGEMENT_GROUPS.includes(r.kensa_group)) continue;
      groups.set(r.kensa_group, { acts: [...(groups.get(r.kensa_group)?.acts ?? []), a] });
    }
    let undecided = 0;
    for (const [group, g] of groups) {
      const rows = kensa.all(c.snapshot.si, group) as { code: string }[];
      if (rows.length !== 1) {
        undecided++;
        continue;
      }
      const code = rows[0].code;
      const sameAsCode = new Set(info.same(code));
      // 請求か確かめた行為に同じ区分が月の中にあれば立てない
      if (present(code, 1, true) || acts.some((a) => a.act.match && sameAsCode.has(a.act.match.code))) continue;
      const first = g.acts.map((a) => a.date).sort()[0];
      const name = nameOfCode(c, code);
      add({
        kind: "derived",
        date: first,
        day: Number(first.slice(8, 10)),
        units: [unitOn([{ kind: "SI", code }], Number(first.slice(8, 10)))],
        report: [{ code, written: name, quote: g.acts[0].act.quote, noteId: g.acts[0].noteId, name }],
        derived: { what: [...new Set(g.acts.map((a) => `『${a.act.written}』`))].join("・"), basis: "マスターの検査のグループ", name },
      });
    }
    if (undecided > 0) tally("判断料の行を 1 つに決められない検査のグループ", undecided);
    // 処方箋料：院内処方もある施設で院外処方箋と選んだ日、院外処方だけの施設で処方の記載がある日
    for (const r of about.rxDays ?? []) {
      if (!r.date.startsWith(`${about.yearMonth}-`) || !r.rx || info.rxPrimary === null) continue;
      if (!((about.dispensing === "inside" && r.choice === "outside") || about.dispensing === "outside")) continue;
      const day = Number(r.date.slice(8, 10));
      if (rxPresent(day) || acts.some((a) => a.date === r.date && a.act.match && info.rxCodes.has(a.act.match.code))) continue;
      const quote = (byDay.get(r.date) ?? []).find((a) => a.act.category === "投薬")?.act.quote ?? "";
      add({ kind: "derived", date: r.date, day, units: [unitOn([{ kind: "SI", code: info.rxPrimary }], day)], report: [{ code: info.rxPrimary, written: "処方箋料", quote, name: "処方箋料" }], derived: { what: "処方の記載", basis: "処方の記載", name: "処方箋料" } });
    }
  }

  // 3. 手順 1 の前に外す：背反区分 3（どちらか一方）の相手が元の請求にある行為（C-283）
  // 特例条件のある行（tokurei が 0 でない）は、条件によっては両方を算定できるので「どちらか一方」と決まる組に入れない（往診料と訪問診療料など。R10 が担当。段 18c の外れ）
  const either = db.prepare("SELECT tani, code1, code2, change, created_on, abolished_on FROM haihan WHERE snapshot = ? AND kubun = '3' AND tokurei = '0' AND (code1 = ? OR code2 = ?)");
  const partnerInClaim = (code: string, day: number): boolean =>
    (either.all(t.snapshot, code, code) as (Dated & { tani: number; code1: string; code2: string })[]).some((r) => {
      if (!t.live(r)) return false;
      const other = r.code1 === code ? r.code2 : r.code1;
      if (idx.untimed.has(other)) return true;
      const d = idx.days.get(other);
      if (!d) return false;
      if (r.tani === 2) return d.some((n) => n > 0);
      if (r.tani === 4) return d.some((n, i) => n > 0 && Math.abs(i + 1 - day) <= 6);
      return d[day - 1] > 0;
    });
  let eitherInClaim = 0;
  const live = cands.filter((x) => {
    if (x.kind === "qty" || x.kind === "with") return true;
    const out = x.units.some((u) => u.items.some((it) => it.kind === "SI" && partnerInClaim(it.code, x.day)));
    if (out) eitherInClaim++;
    return !out;
  });
  if (eitherInClaim > 0) tally("どちらか一方の組で、請求に相手がある", eitherInClaim);

  // R ルールと 2 回言わない（取り込んだ請求）：R03・R14 が同じ月の取り忘れを言っていれば、その区分の候補は言わない（R ルールの側を残す。§0-12）
  const handSays = new Set((opt.hand ?? []).flatMap((f) => (f.messageKey === "R03.missing" ? [rev.consts.hokatsu.kubun] : f.messageKey === "R14.missing" ? [rev.consts.ikou.kubun] : [])));
  if (handSays.size > 0)
    for (let i = live.length - 1; i >= 0; i--)
      if (live[i].units.some((u) => u.items.some((it) => it.kind === "SI" && handSays.has(info.kubunOf(it.code) ?? "")))) {
        live.splice(i, 1);
        tally("手書きのルールが同じ取り忘れを言っているもの");
      }

  // 4. 手順 1：1 つずつ
  const hidden: G11Hidden[] = [];
  const passed: Cand[] = [];
  for (const x of live) {
    const binds = [...(bindsOf(c, checks, claim, x.units.map((unit) => ({ cand: x.id, unit }))).get(x.id) ?? []), ...x.units.flatMap((u) => kaisuBinds(c, idx, u, firstDow))];
    let block = binds.find((b) => b.certain);
    // 同じ族の区分誤りは G10 より C-250 を勝たせる（L-128）：抑えが R18 の担当の施設基準の届出なしだけで、R18 が同じ族の直し先を持つときは隠さず添え書き
    const r18Codes = new Set(KIJUN_OWNERS.filter((o) => o.rule === "R18").flatMap((o) => o.codes));
    const hard = binds.filter((b) => b.certain);
    if (block && opt.sameFamily && hard.every((b) => b.check === "G10" && (b.kijunCodes ?? "").split("/").every((k) => r18Codes.has(k)))) {
      const n = opt.sameFamily({ date: x.date, units: x.units.map((u) => ({ items: u.items, count: u.count })) });
      if (n) {
        x.notes.push(n);
        block = undefined;
      }
    }
    if (block) {
      for (const r of x.report.length > 0 ? x.report : [{ written: "", code: "" } as Report]) hidden.push({ written: r.written, date: x.date, reason: CHECK_NAME[block.check], check: block.check, partner: block.partner, ...(x.withNames ? { with: x.withNames } : {}) });
      continue;
    }
    for (const b of binds) {
      if (b.certain) continue; // 同じ族の例外で通した届出なし（添え書きは上で付けた）
      if (b.byDeclaration !== undefined) x.notes.push({ reason: "施設基準の申告が分からない", text: `施設基準${b.byDeclaration}の申告が分からないので、算定できるかは施設の申告しだいです（施設の申告による）` });
      else if (b.exception)
        // 例外を名指しする（EM §2-12 の HX の一言をそのまま使う。文を作らない）。同一月の表は「月」、1 日・同時の表は「日」
        x.notes.push({ reason: "データの点検の条件つきの違反", text: `${b.partner}を算定する${b.exception.month ? "月" : "日"}は、原則として算定できません。例外：${b.exception.hxText}。当たらなければ、請求にないままで合っています` });
      else if (b.check !== "G10") x.notes.push({ reason: "データの点検の条件つきの違反", text: `${CHECK_NAME[b.check]}の表では、条件によっては算定できません（相手：${b.partner}。${b.why}）。告示・通知を確かめてください` });
    }
    passed.push(x);
  }

  // 5. 手順 2：まとめて 1 回（候補どうしの包括・背反。隠さない）。包括は G04 を全部の候補を足した請求に掛け、背反は表を両向きに引く
  //    （G05 は同じ組を 1 回だけ言うので、互いに算定しない側になる組の片方を落とす。ここでは向きごとに見る）
  const pairs: [Cand, Cand][] = [];
  {
    const byId = new Map(passed.map((x) => [x.id, x]));
    const note = (me: Cand, other: Cand, kind: string) => {
      const text = `『${other.report[0]?.written ?? ""}』（これも取り忘れの候補）を算定すると、${kind}で算定できません。どちらを算定するか確かめてください`;
      if (!me.notes.some((n) => n.text === text)) me.notes.push({ reason: "候補どうしの包括・背反", text });
    };
    const all = passed.flatMap((x) => x.units.map((unit) => ({ cand: x.id, unit })));
    const base = claim.units.length;
    if (checks.some((k) => k.id === "G04"))
      for (const [id, list] of bindsOf(c, checks.filter((k) => k.id === "G04"), claim, all))
        for (const b of list) {
          if (b.partnerUnit === undefined) continue;
          const other = byId.get(all[b.partnerUnit - base].cand);
          if (other && other.id !== id) note(byId.get(id)!, other, "包括");
        }
    if (checks.some((k) => k.id === "G05")) {
      const rows = db.prepare("SELECT tani, kubun, tokurei, change, created_on, abolished_on FROM haihan WHERE snapshot = ? AND code1 = ? AND code2 = ?");
      const si = (x: Cand) => [...new Set(x.units.flatMap((u) => u.items.filter((it) => it.kind === "SI").map((it) => it.code)))];
      const near = (tani: number, a: Cand, b: Cand) => (tani === 2 ? true : tani === 4 ? Math.abs(a.day - b.day) <= 6 : a.day === b.day);
      const either: [Cand, Cand][] = [];
      for (const a of passed)
        for (const b of passed) {
          if (a.id === b.id) continue;
          for (const ca of si(a))
            for (const cb of si(b))
              for (const r of rows.all(t.snapshot, ca, cb) as (Dated & { tani: number; kubun: string; tokurei: string })[]) {
                if (!t.live(r) || !near(r.tani, a, b)) continue;
                if (r.kubun === "1") note(b, a, "背反");
                else if (r.kubun === "2") note(a, b, "背反");
                else if (r.kubun === "3" && r.tokurei === "0") either.push([a, b]);
              }
        }
      // 背反区分 3（どちらか一方）が候補どうしで成り立つ組（L-113）。1 つの候補は 1 つの組にだけ入れる（コードの順に決める。並べ方に依らない）
      const key = (x: Cand) => `${x.date}|${x.report[0]?.code ?? ""}`;
      for (const [a, b] of either.map(([a, b]) => (key(a) < key(b) ? [a, b] : [b, a])).sort((p, q) => (key(p[0]) + key(p[1]) < key(q[0]) + key(q[1]) ? -1 : 1))) {
        if (pairs.some(([p, q]) => [p.id, q.id].includes(a.id) || [p.id, q.id].includes(b.id))) continue;
        pairs.push([a, b]);
      }
    }
  }

  // 6. 手順 3：手書きのルール（呼び出し側。隠さない）
  if (opt.step3 && passed.length > 0) {
    const s3 = opt.step3(passed.map((x) => ({ id: x.id, date: x.date, units: x.units.map((u) => ({ items: u.items, count: u.count })) })));
    for (const x of passed) for (const n of s3.notes.get(x.id) ?? []) if (!x.notes.some((m) => m.text === n.text)) x.notes.push(n);
    scope.push(...s3.scope);
  }

  // 7. 手順 4：出す（コードごとに 1 件で日の一覧。添え書きのある件は後ろ）。添え書き・言わなかった一覧は文の順に並べる（候補の並べ方に依らない）
  for (const x of passed) x.notes.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  hidden.sort((a, b) => (`${a.date}|${a.written}|${a.reason}` < `${b.date}|${b.written}|${b.reason}` ? -1 : 1));
  const inPair = new Set(pairs.flatMap(([a, b]) => [a.id, b.id]));
  const findings: G11Finding[] = [];
  const ref = (r: Report[]) => `note=${[...new Set(r.flatMap((x) => (x.noteId !== undefined ? [x.noteId] : [])))].sort((a, b) => a - b).join(",")}`;
  const grouped = new Map<string, { key: G11Kind; code: string; reps: { r: Report; cand: Cand }[] }>();
  for (const x of passed) {
    if (inPair.has(x.id)) continue;
    if (x.kind === "qty") {
      const r = x.report[0];
      const name = x.qty!.child ? `「${r.written}」で使った「${x.qty!.child}」` : `『${r.written}』`;
      const text =
        x.qty!.key === "G11.quantity_less"
          ? `カルテ（${md(x.date)}日）では${name}が${x.qty!.chart}、請求では${x.qty!.claim}です。算定できるか確かめてください`
          : `カルテ（${md(x.date)}日）では${name}が${x.qty!.chart}、請求では${x.qty!.claim}です。カルテの記載と請求を確かめてください`;
      findings.push({ messageKey: x.qty!.key, certainty: "条件つき", codes: [r.code], text, days: [{ date: x.date, quote: r.quote, notes: x.notes }], caution: x.notes.length > 0, source: { data: "chart", ref: ref(x.report) } });
      continue;
    }
    const key: G11Kind = x.kind === "with" ? "G11.missing_with" : x.kind === "derived" ? "G11.missing_derived" : "G11.missing";
    for (const r of x.report) {
      const k = `${key}|${r.code}`;
      const g = grouped.get(k) ?? { key, code: r.code, reps: [] };
      g.reps.push({ r, cand: x });
      grouped.set(k, g);
    }
  }
  for (const g of grouped.values()) {
    const dates = g.reps.map((x) => x.cand.date);
    const first = g.reps[0];
    const text =
      g.key === "G11.missing_with"
        ? `カルテ（${daysText(dates)}日）の『${first.cand.parent}』で使った『${first.r.written}』が、請求にありません。確かめてください`
        : g.key === "G11.missing_derived"
          ? `カルテ（${daysText(dates)}日）に${first.cand.derived!.what}があり、${first.cand.derived!.name}が請求にありません。${first.cand.derived!.basis}から決まる項目です。算定できるか確かめてください`
          : `カルテ（${daysText(dates)}日）に『${first.r.written}』（${first.r.name}）がありますが、請求にありません。カルテに記録された行為です。算定できるか確かめてください`;
    // 同じ日の行為（同じコードの 2 回など）は 1 つの日の行にまとめる（引用は文の順に並べ、添え書きは重ねない）
    const byDate = new Map<string, { quotes: string[]; notes: Note[] }>();
    for (const { r, cand } of g.reps) {
      const d = byDate.get(cand.date) ?? { quotes: [], notes: [] };
      d.quotes.push(r.quote);
      for (const n of cand.notes) if (!d.notes.some((m) => m.text === n.text)) d.notes.push(n);
      byDate.set(cand.date, d);
    }
    const days = [...byDate].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, d]) => ({ date, quote: [...new Set(d.quotes)].sort().join("／"), notes: d.notes.sort((a, b) => (a.text < b.text ? -1 : 1)) }));
    findings.push({ messageKey: g.key, certainty: "条件つき", codes: [g.code], text, days, caution: days.some((d) => d.notes.length > 0), source: { data: "chart", ref: ref(g.reps.map((x) => x.r)) } });
  }
  for (const [a, b] of pairs) {
    const [ra, rb] = [a.report[0], b.report[0]];
    const days = [...new Set([a.date, b.date])];
    const notes = [...a.notes, ...b.notes];
    findings.push({
      messageKey: "G11.missing_either",
      certainty: "条件つき",
      codes: [ra.code, rb.code],
      text: `カルテ（${daysText(days)}日）に『${ra.written}』（${ra.name}）と『${rb.written}』（${rb.name}）があり、どちらも請求にありません。どちらか一方を算定できる見込みです。どちらで算定するか、算定できるかを確かめてください`,
      days: days.sort().map((date) => ({ date, quote: [ra, rb].filter((_, i) => [a, b][i].date === date).map((r) => r.quote).join("／"), notes: [a, b].filter((x) => x.date === date).flatMap((x) => x.notes) })),
      caution: notes.length > 0,
      source: { data: "chart", ref: ref([ra, rb]) },
    });
  }
  // 添え書きのない件を先に、注意つきを後ろに（並べ方は日・コードの順。候補の並べ方に依らない）
  const order = (f: G11Finding) => `${f.caution ? 1 : 0}|${f.days[0]?.date ?? ""}|${f.messageKey}|${f.codes.join(",")}`;
  findings.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));

  // 8. 点検の範囲
  if (unmatched > 0) tally("当てられない行為", unmatched);
  for (const [text, { n, suffix }] of scopeCount) scope.push(`${text}：${n} 件${suffix}`);
  const hiddenBy: Record<string, number> = {};
  for (const h of hidden) hiddenBy[h.reason] = (hiddenBy[h.reason] ?? 0) + 1;
  if (hidden.length > 0) scope.push(`算定できない見込みなので言わない：${hidden.length} 件（${Object.entries(hiddenBy).map(([k, v]) => `${k} ${v}`).join("・")}）`);
  const caution: Partial<Record<CautionReason, number>> = {};
  const cautionFindings = findings.filter((f) => f.caution);
  for (const reason of CAUTION_REASONS) {
    const n = cautionFindings.filter((f) => f.days.some((d) => d.notes.some((x) => x.reason === reason))).length;
    if (n > 0) caution[reason] = n;
  }
  if (cautionFindings.length > 0) scope.push(`注意つきで出したもの：${cautionFindings.length} 件（${Object.entries(caution).map(([k, v]) => `${k} ${v}`).join("・")}）`);
  const byDecl = findings.filter((f) => f.days.some((d) => d.notes.some((x) => x.reason === "施設基準の申告が分からない"))).length;
  if (byDecl > 0) scope.push(`施設基準の申告が分からないまま出したもの：${byDecl} 件。施設の申告を確かめてください`);
  const guide = undecidedDays.size > 0 ? `${[...undecidedDays].sort().map((d) => `${md(d)}日`).join("・")}の処方の院内・院外を選ぶと、薬の取り忘れを見ます` : null;
  const byKind: Partial<Record<G11Kind, number>> = {};
  for (const f of findings) byKind[f.messageKey] = (byKind[f.messageKey] ?? 0) + 1;
  // 区分誤りの出た対応：R18 の同じ族の区分誤りの添え書きがある候補だけ（回数の区分〔R01 など〕では消さない。C-263）
  const doubtKeys = new Set<string>();
  const kubunDoubts: KubunDoubt[] = [];
  for (const x of passed)
    if (x.notes.some((n) => n.doubt && n.rule === "R18"))
      for (const r of x.report) {
        const k = `${r.written}|${r.tbl}|${r.code}`;
        if (r.tbl && !doubtKeys.has(k)) {
          doubtKeys.add(k);
          kubunDoubts.push({ written: r.written, tbl: r.tbl, code: r.code });
        }
      }
  // R01 の回数の区分誤り（月 1 回の区分へ）と、訪問診療料の取り忘れ：R01 の指摘に、取り忘れを先に確かめる文を添える（R01 の指摘は消さない）
  const visit = new Set(rev.consts.visitKubun);
  const handNotes: { messageKey: string; text: string }[] = [];
  const visitMissing = findings.some((f) => f.messageKey === "G11.missing" && f.codes.some((code) => visit.has(info.kubunOf(code) ?? "")));
  if (visitMissing && (opt.hand ?? []).some((f) => f.messageKey === "R01.use_once")) {
    const n = new Set(acts.filter((a) => a.act.match && visit.has(info.kubunOf(a.act.match.code) ?? "")).map((a) => a.date)).size;
    handNotes.push({ messageKey: "R01.use_once", text: `カルテでは訪問診療が ${n} 回あります。訪問診療料の取り忘れ（G11）を先に確かめてください` });
  }
  return { findings, hidden, kubunDoubts, handNotes, guide, scope, counts: { acts: acts.length, unmatched, notSeen: counts.notSeen, hidden: hiddenBy, caution, byKind } };
}
