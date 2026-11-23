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
import type { ChartAct, ChildKind, RxChoice } from "../chart/acts";
import { checkReady, hasUnitColumns, iyakuhinOf, pickSnapshot, shinryoOf, tokuteiOf, unitCaseCollisions, type MastersDb } from "../masters/db";
import { g03 } from "./g03";
import { g04 } from "./g04";
import { g05 } from "./g05";
import { g10, g10Blocking } from "./g10";
import type { Finding } from "../engine/types";
import { KIJUN_OWNERS } from "../facility/codes";
import { TABLE, tensuhyoOf, type Dated } from "./tensuhyo";
import type { GenericAbout, GenericAboutMore, GenericCheck, GenericCheckId, GenericFinding } from "./types";
import type { Part, RxOrder, StructuredChart } from "../connect/types";
import type { SItem } from "../structured/overlap";
import { RULE_CODES } from "../structured/rule-codes";
import { isOutsideText } from "../structured/outside-words";
import { hasTimeHint } from "../structured/time-hint";
import { codeOfDevice, DEVICE_KINDS, MATERIAL_MONTH_COMMENTS, OXYGEN_KINDS, unitOfDevice, type C150Detail, type DeviceKey } from "../structured/devices";

// ───────────────────────────────────────────────────────────────────────────
// 入力

/** 本人が確かめた行為 1 つ（カルテの日付と、その日の記載の id）。index は保存したカルテの行ったことの中の位置（保存したカルテだけ。当てられない行為をあとから選ぶ入口。X-157） */
export type ConfirmedAct = {
  date: string;
  noteId?: number;
  index?: number;
  act: ChartAct;
  /** 構造化データから来た行為（design.md §16-3。quote は接続先の表示名、ref は接続先の行の id） */
  source?: "structured";
  ref?: string;
  /** 候補に添える文（16-3 の「文章にあるがオーダーにない」） */
  note?: string;
};
/**
 * その日の処方の記載があるか（rx）と、本人が選んだ（なければ初期値の規則で出た）院内・院外。
 * confirmed：本人がその日の院内・院外を確かめた印があり、いまの処方の文で効く（design.md §16-4-1。C-410。文字の初期値だけでは付かない）
 */
export type RxDay = { date: string; rx: boolean; choice: RxChoice | null; confirmed?: boolean };
/**
 * 構造化データから規則で出す算定の入力（design.md §16-4。段 19c・19d）。ないときは規則の候補を出さない（v32 のまま）。
 * history：さかのぼって読む月（当月の前の月から順に lookbackMonths 個）。orders は残した処方のオーダー（残していない月は null）、items はその月の当てたコードつきの行為。
 * texts：カルテの文章のある日（当月とさかのぼる月。確かめたかは問わない）。text は S・O・A・P・処方の欄を合わせた文、soap は S・O・A・P だけの文（時間の語の規則に使う。処方の欄の「分3」「疼痛時1錠」に当てない。C-444）、confirmed は確かめたか。choice・rxAct はさかのぼる月の日だけが持つ（当月は rxDays・acts で見る）。
 * times：医療事務が入れた訪問の時刻（16-6。出どころは「医療事務が入れた」）
 */
export type G11Structured = {
  chart: StructuredChart;
  items: SItem[];
  history: { yearMonth: string; orders: Part<RxOrder> | null; items: SItem[] }[];
  lookbackMonths: number;
  texts: { date: string; text: string; soap: string; confirmed: boolean; choice?: RxChoice | null; rxAct?: boolean }[];
  times: { date: string; ref: string | null; start: string; end: string; by: string; at: string }[];
  /** 患者の機器から規則で出す材料加算の入力（design.md §16-4-7・16-5。段 19e）。ないときは材料加算を見ない（段 19d まで） */
  devices?: G11Devices;
};
/**
 * 材料加算の入力（16-4-7）。checked：機器を確かめた患者か。rows：診療年月に効く機器の行（source は出どころの印）。
 * pending：確かめていない変える案の種類（当てられない案は null）。prev：前の 2 か月のうち取り込んだ請求のある月の、単位ごとのコードとコメント。
 * c103：電子カルテの在宅療養の指示に C103 の 2 の指導管理がある
 */
export type G11Devices = {
  checked: boolean;
  rows: { kind: DeviceKey; fromMonth: string; c150?: C150Detail | null; source: string }[];
  pending: (DeviceKey | null)[];
  prev: { yearMonth: string; units: { codes: string[]; comments: string[] }[] }[];
  c103: boolean;
};
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
  structured?: G11Structured;
  /** 構造化データのない請求の、患者の機器（機器を確かめた患者だけ。v34 の 16-4-1：材料加算は機器があれば今までどおり見る。C-440） */
  devices?: G11Devices;
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
export const CAUTION_REASONS = [
  "データの点検の条件つきの違反",
  "候補どうしの包括・背反",
  "同じ族の区分誤り",
  "情報不足",
  "手書きのルールの指摘",
  "手書きのルールで判定できない行",
  "施設基準の申告が分からない",
  "文章にあるがオーダーにない",
  "院内・院外の食い違い",
  "規則の添え書き",
  "規則の項目が取れない",
] as const;
export type CautionReason = (typeof CAUTION_REASONS)[number];
/** rule：添え書きの元の手書きのルール。doubt：同じ族の区分誤り（R18 のときだけ kubunDoubts に入れる。C-263） */
export type Note = { reason: CautionReason; text: string; rule?: string; doubt?: boolean };

// ───────────────────────────────────────────────────────────────────────────
// 出力

export type G11Kind = "G11.missing" | "G11.missing_with" | "G11.missing_either" | "G11.missing_derived" | "G11.missing_rule" | "G11.quantity_less" | "G11.quantity_more";
/** quantity：規則の候補の数量（患家診療時間加算の分。design.md §16-4-6） */
export type G11Day = { date: string; quote: string; notes: Note[]; quantity?: string };
/**
 * 規則の候補の根拠（design.md §16-4-1）。basis：order＝処方のオーダー／visit＝訪問の記録／device＝患者の機器／chart＝処方の欄で本人が院内と確かめた日（L-199 (a)）。
 * sources：出どころの印（電子カルテ／医療事務が入れた〔誰・いつ〕）
 */
export type RuleBasis = { basis: "order" | "visit" | "device" | "chart"; sources: string[] };
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
  /** 規則の候補（G11.missing_rule）だけ */
  rule?: RuleBasis;
};
/**
 * 当てられない行為（design.md §15-7・15-9。X-157）：日・書かれた名前・種類。保存したカルテの行為は、カルテの id と位置（候補から選んで残す入口）。
 * child は手技で使った薬・器材（with）の当てられないもの：with の中の位置・種類・親の書かれた名前（category・index は親のもの。X-161）
 */
export type G11Unmatched = { date: string; written: string; category: ChartAct["category"]; noteId?: number; index?: number; child?: { index: number; kind: ChildKind; parent: string } };
/** 言わなかった候補（L-96）：書かれた名前・日・理由（抑えた点検の名前と相手の行の名前） */
export type G11Hidden = { written: string; date: string; reason: string; check: GenericCheckId; partner: string; with?: string[] };
/** 区分誤りの出た対応（C-250・C-263）：R18 の同じ族の区分誤りが添えられた候補の、書かれた名前・表・コード（結果に載せるだけ。前に選んだ対応は消さず、読むときに同じ R18 の規則で外す：src/server/app/notes.ts の aliasOf。反証 round-55 C-293） */
export type KubunDoubt = { written: string; tbl: string; code: string };
export type G11Result =
  | { skip: string }
  | {
      findings: G11Finding[];
      hidden: G11Hidden[];
      /** 当てられない行為（取り忘れは言わない。L-94） */
      unmatchedActs: G11Unmatched[];
      kubunDoubts: KubunDoubt[];
      /** 手書きのルールの指摘に添える文（R01 の回数の区分誤り。条件つきに下げる。design.md §15-8 の「R ルールと 2 回言わない」） */
      handNotes: { messageKey: string; text: string }[];
      /** 院内・院外が選ばれていない日の案内（たたまない 1 行。C-243）。なければ null */
      guide: string | null;
      /** 規則の候補の入力の案内（効く場面の日だけ。訪問の時刻・処方の日の「確かめた」の印。design.md §16-6。たたまない 1 行ずつ） */
      ruleGuides: string[];
      /** 時刻の入力を案内する日（16-6 の 2 つの場面。B の欄で時刻を入れる欄を出す日） */
      visitTimeDays: string[];
      /** 材料加算の候補の欄の上に出す 1 行ずつ（見ていないもの。design.md §16-4-7。L-181・L-186） */
      materialNotes: string[];
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
/** 「（n日）」。日を付けない候補（日付が診療年月だけ。X-162）は出さない */
const daysPart = (dates: string[]) => {
  const ds = dates.filter((d) => d.length === 10);
  return ds.length > 0 ? `（${daysText(ds)}日）` : "";
};
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
/**
 * 規則の候補（design.md §16-4）。key：同じ規則の候補を 1 件にまとめる鍵（日の一覧を持つ）。label：名称。basisLabel：文の頭の根拠（「オーダー」など）。
 * requirement：要件の要旨（文の中）。dayQuote・quantity：日の行に出す文と数量
 */
type RuleCand = { key: string; label: string; basisLabel: string; requirement: string; basis: RuleBasis; dayQuote: string; quantity?: string; either?: string[] };
type Cand = {
  id: number;
  kind: "act" | "with" | "drugs" | "derived" | "qty" | "rule";
  date: string;
  day: number;
  units: AddedUnit[];
  /** 手順 1 で、units が抑えられたときに代わりに確かめる単位（1 つずつ。処方料：区分を決めないので、両方の区分が抑えられたときだけ隠す。16-4-2。材料加算の「どれか 1 つ」：全部が抑えられたときだけ隠す。16-4-7） */
  alt?: AddedUnit[];
  rule?: RuleCand;
  /** 指摘に出す行為（組は、カルテにあって請求にないもの） */
  report: Report[];
  /** with：親の書かれた名前／derived：何から決まったか（文）／qty：量の指摘 */
  parent?: string;
  /** act：組ごと隠したときに言わなかった一覧に添える、手技で使った薬・器材の書かれた名前（with） */
  withNames?: string[];
  /** fromClaim：請求にある項目だけから決まった（文を「請求（n日）に」で始める。X-158） */
  derived?: { what: string; basis: string; name: string; fromClaim?: boolean };
  qty?: { key: "G11.quantity_less" | "G11.quantity_more"; chart: string; claim: string; child?: string };
  /** 手順 1〜3 の添え書き */
  notes: Note[];
};

/** 同じ日・同じ親の区分の中の同じ子の区分ごとの、子の量（X-156） */
type ChildGroups = Map<string, { kind: G11Item["kind"]; code: string; parent: string; parentCodes: string[]; child: string; items: { quantity?: string; quote: string; noteId?: number }[] }>;

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
  // 注14 の減の行と組の通常の行（note14Pairs）は、どちらかがその月にあれば「ある」（通常と減のどちらが正しいかは R18 の担当。design.md §15-8。段 17h）
  const pairs = Object.entries(rev.consts.kanri.note14Pairs ?? {});
  const partners = (k: string): string[] => {
    const normal = pairs.find(([red]) => red === k)?.[1] ?? k;
    return [normal, ...pairs.filter(([, n]) => n === normal).map(([red]) => red)];
  };
  const same = (code: string): string[] => {
    const k = kubunOfCode(rev, code);
    return k ? [...new Set(partners(k).flatMap(codesOf))] : [code];
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

/** exception.unit：例外を名指しする添え書きの、表の単位（同一月＝月、1 日＝日、1 週間＝週、同時＝同時。C-295） */
type Bind = { check: GenericCheckId; certain: boolean; partner: string; why: string; byDeclaration?: string; exception?: { hxText: string; unit: "月" | "日" | "週" | "同時" }; kijunCodes?: string };

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

/** 特例条件ありの背反の指摘か（G05 の _cond・例外・院内の知識の形。whyOf の「特例条件あり」と同じ見分け） */
const markedG05 = (f: GenericFinding) => f.messageKey.endsWith("_cond") || f.messageKey.startsWith("G05.exception") || f.messageKey.startsWith("G05.local");

/**
 * 指摘 1 件のうち、算定できない側（X-140）。包括は含まれる側、背反の区分 1・2 は表が算定しない側。
 * 区分 3（どちらか一方）は、特例条件のない組は空（手順 1 の前に外す・手順 2 で 1 件にまとめる）。特例条件のある組は両側（C-291。条件つき・例外の扱いは区分 1・2 と同じ）。
 * ただし eitherSkip の組（往診料と訪問診療料。R10 が日つきの添え書きで扱う）は空のまま
 */
function losersOf(f: GenericFinding, eitherSkip: (a: string, b: string) => boolean): { loser: string; partner: string }[] {
  if (f.check === "G04") return [{ loser: f.codes[1], partner: f.codes[0] }];
  if (f.check === "G05") {
    const keep = f.params.keep;
    if (keep === f.codes[0]) return [{ loser: f.codes[1], partner: f.codes[0] }];
    if (keep === f.codes[1]) return [{ loser: f.codes[0], partner: f.codes[1] }];
    if (!markedG05(f) || eitherSkip(f.codes[0], f.codes[1])) return [];
    return [
      { loser: f.codes[0], partner: f.codes[1] },
      { loser: f.codes[1], partner: f.codes[0] },
    ];
  }
  return [{ loser: f.codes[0], partner: f.codes[0] }];
}
/** 例外の添え書きの表の単位（指摘の出どころの表の名前と、同時の表の where から決める。C-295） */
function unitOfException(f: GenericFinding): "月" | "日" | "週" | "同時" {
  if (f.params.where === "同じレセプト") return "月";
  if (f.source.data === TABLE.haihan[3]) return "同時";
  if (f.source.data === TABLE.haihan[4]) return "週";
  return "日";
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
  if (markedG05(f)) return "特例条件あり";
  if (f.messageKey === "G05.week" || f.messageKey.startsWith("G06.week")) return "1 週間の数え方";
  if (f.messageKey === "G05.same_day") return "別の単位の同時";
  if (f.messageKey.startsWith("G04.same") || f.messageKey.startsWith("G04.surgery")) return "同時・1 手術の単位";
  if (f.messageKey === "G06.master_limit") return "マスターの上限回数";
  return "診療年月より後のマスター";
}

/** eitherSkip：背反区分 3・特例条件ありでも G05 の抑えにしない組（往診料と訪問診療料。R10 の担当） */
type Ctx = { db: MastersDb; about: G11About; snapshot: { si: string; iy: string | null; to: string | null }; eitherSkip: (a: string, b: string) => boolean };

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
      for (const lp of losersOf(f, c.eitherSkip))
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
          ...(OPEN_EXCEPTION.has(f.messageKey) && f.params.hxText ? { exception: { hxText: f.params.hxText, unit: unitOfException(f) } } : {}),
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
  // 構造化データがあれば、文章の行為がなくても規則の候補を見る（design.md §16-4）
  if (acts.length === 0 && !about.structured) return { skip: "確かめたカルテの「行ったこと」がないので、取り忘れは見ていません" };
  if (!db) return { skip: "基本マスターがないので、取り忘れは見ていません" };
  // G11 が頼る点検（G03〜G06・G10）が判定不能なら、その請求の取り忘れは何も言わない（X-131・X-136）
  for (const [id, label] of [["G11", "取り忘れ"], ["G03", "行の属性"], ["G04", "包括"], ["G05", "背反"], ["G06", "回数"], ["G10", "施設基準"]] as const) {
    const ready = checkReady(db, id);
    if (!ready?.ready) return { skip: `${id}（${label}）が動いていないので、算定できるかを確かめられず、取り忘れは見ていません` };
  }
  if (!about.declaration) return { skip: "G10（施設基準）が動いていないので、算定できるかを確かめられず、取り忘れは見ていません" };
  const si = pickSnapshot(db, "shinryo", about.yearMonth, about.generation);
  if (!si || !tensuhyoOf(db, about)) return { skip: `診療年月の世代（${about.generation}）のマスターがないので、取り忘れは見ていません` };
  const info = revInfo(rev);
  // 往診料と訪問診療料の組（背反区分 3・特例条件あり）は R10 が日つきの添え書きで扱うので、G05 の抑えにしない（段 18c のまま。C-291）
  const isOushin = (code: string) => info.kubunOf(code) === rev.consts.oushin.kubun;
  const isVisit = (code: string) => rev.consts.visitKubun.includes(info.kubunOf(code) ?? "");
  const eitherSkip = (a: string, b: string) => (isOushin(a) && isVisit(b)) || (isOushin(b) && isVisit(a));
  const c: Ctx = { db, about, snapshot: { si: si.snapshot, iy: pickSnapshot(db, "iyakuhin", about.yearMonth, about.generation)?.snapshot ?? null, to: pickSnapshot(db, "tokutei", about.yearMonth, about.generation)?.snapshot ?? null }, eitherSkip };
  const checks = opt.checks ?? [g03, g04, g05, g10];
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
  const add = (x: Omit<Cand, "id" | "notes">, notes: Note[] = []) => cands.push({ ...x, id: nextId++, notes: [...notes] });
  /** 構造化データとの突き合わせで添えた文（16-3。文章にあるがオーダーにない） */
  /** 行為に添える規則の文（時刻が分かれば規則で確かめる。16-3） */
  const extraNotes = new Map<ConfirmedAct, Note[]>();
  const orderNotes = (list: ConfirmedAct[]): Note[] => [
    ...[...new Set(list.flatMap((a) => (a.note ? [a.note] : [])))].map((text): Note => ({ reason: "文章にあるがオーダーにない", text })),
    ...list.flatMap((a) => extraNotes.get(a) ?? []),
  ];

  // ── 構造化データから規則で出す算定の準備（design.md §16-4。段 19c・19d）。S がなければ何もしない（v32 のまま）
  const S = about.structured ?? null;
  /** 材料加算の入力：構造化データの請求はその中の機器、ない請求は患者の機器（C-440） */
  const DV = S ? (S.devices ?? null) : (about.devices ?? null);
  const ym = about.yearMonth;
  const inMonth = (d: string) => d.startsWith(`${ym}-`);
  const kubunCodes = (k: string) => (Object.hasOwn(rev.codes, k) ? [rev.codes[k].primary, ...rev.codes[k].accept] : []);
  /** マスターの区分番号（アルファベット＋区分番号）に当たるか。区分番号の単位で「ある・ない」を見る（F100・F400・A000・A001） */
  const kubunMemo = new Map<string, string | null>();
  const kubunNoOf = (code: string): string | null => {
    if (!kubunMemo.has(code)) {
      const r = shinryoOf(db, c.snapshot.si, code);
      kubunMemo.set(code, r ? `${r.alpha}${r.kubun_no}` : null);
    }
    return kubunMemo.get(code)!;
  };
  const inKubun = (code: string, keys: string[]) => keys.includes(kubunNoOf(code) ?? "");
  /** その区分番号のどれかのコードが、請求のその日にある（算定日の分からない単位は月の中） */
  const kubunOnDay = (keys: string[], day: number) => [...idx.days].some(([code, d]) => (d[day - 1] ?? 0) > 0 && inKubun(code, keys)) || [...idx.untimed].some((code) => inKubun(code, keys));
  /** その区分番号のコードが請求にある日（算定日の分からない単位は日を数えず、月の中に 1 つあれば 1） */
  const kubunDays = (keys: string[]): number => {
    const ds = new Set<number>();
    for (const [code, d] of idx.days) if (inKubun(code, keys)) d.forEach((n, i) => n > 0 && ds.add(i + 1));
    return ds.size > 0 ? ds.size : [...idx.untimed].some((code) => inKubun(code, keys)) ? 1 : 0;
  };
  const codesOnDay = (codes: Iterable<string>, day: number) => [...codes].some((x) => idx.untimed.has(x) || (idx.days.get(x)?.[day - 1] ?? 0) > 0);
  const codeDays = (codes: Iterable<string>): string[] => {
    const ds = new Set<string>();
    for (const x of codes) (idx.days.get(x) ?? []).forEach((n, i) => n > 0 && ds.add(`${ym}-${String(i + 1).padStart(2, "0")}`));
    return [...ds];
  };
  const ordersPart = S?.chart.orders ?? null;
  const orderMonth = ordersPart?.status === "supported";
  const ordersOn = new Map<string, RxOrder[]>();
  if (ordersPart?.status === "supported") for (const o of ordersPart.items) if (inMonth(o.date)) ordersOn.set(o.date, [...(ordersOn.get(o.date) ?? []), o]);
  /** オーダーの日の院内・院外（16-4-1。オーダーを受け取っている月は、オーダーで決める） */
  const orderDay = (date: string) => {
    const os = ordersOn.get(date);
    if (!os) return null;
    const inside = os.filter((o) => o.place === "院内");
    const outside = os.filter((o) => o.place === "院外");
    const place = inside.length > 0 && outside.length > 0 ? "mixed" : inside.length > 0 ? "inside" : outside.length > 0 ? "outside" : "blank";
    return { place, inside, outside };
  };
  const orderRefOf = (ref: string) => ref.slice(0, ref.lastIndexOf("/"));
  const orderDrugs = (orders: RxOrder[], items: SItem[] = S?.items ?? []) => {
    const refs = new Set(orders.map((o) => o.ref));
    return items.filter((x) => x.kind === "drug" && refs.has(orderRefOf(x.ref)));
  };
  const PLACE_LABEL = { inside: "院内", outside: "院外" } as const;
  /** 食い違いの添え書き（施設の申告・本人の選択とオーダー。FR-207。利用者の判断 2026-11-23） */
  const mismatch = (date: string, place: "inside" | "outside"): Note[] => {
    const out: Note[] = [];
    if (about.dispensing === "outside" && place === "inside") out.push({ reason: "院内・院外の食い違い", text: "施設の申告は院外処方だけ。オーダーは院内" });
    const r = rxDay.get(date);
    if (r?.confirmed && (r.choice === "inside" || r.choice === "outside") && r.choice !== place)
      out.push({ reason: "院内・院外の食い違い", text: `本人の選択は${r.choice === "inside" ? "院内" : "院外処方箋"}。オーダーは${PLACE_LABEL[place]}` });
    return out;
  };
  /** 本人の選択と申告で院内と決まり、「確かめた」の印のある日（L-199 (a)。オーダーのある日は除く） */
  const confirmedInside = (date: string) => {
    const r = rxDay.get(date);
    return !ordersOn.has(date) && about.dispensing === "inside" && !!r?.rx && r.choice === "inside" && r.confirmed === true;
  };
  /** 規則が調剤料・処方料を見る日（文章の調剤料・処方料の行為は、規則の側にたたむ。16-3） */
  const ruleDrugDay = (date: string) => orderDay(date)?.place === "inside" || confirmedInside(date);

  // 訪問の時刻（16-4-6・16-6）：電子カルテの時刻と医療事務が入れた時刻。日をまたぐ記録（終了が開始以前）は見ない（欠け）
  const minutesOf = (start: string | null, end: string | null): number | null => {
    const p = (s: string | null) => (s && /^\d{2}:\d{2}$/.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)) : null);
    const a = p(start);
    const b = p(end);
    return a !== null && b !== null && b > a ? b - a : null;
  };
  type TimeEntry = { ref: string | null; kind: "訪問診療" | "往診" | null; ehr: number | null; clerk: { min: number; by: string; at: string } | null };
  const timesOn = new Map<string, TimeEntry[]>();
  if (S?.chart.visits.status === "supported")
    for (const v of S.chart.visits.items) if (inMonth(v.date)) timesOn.set(v.date, [...(timesOn.get(v.date) ?? []), { ref: v.ref, kind: v.kind, ehr: minutesOf(v.start, v.end), clerk: null }]);
  for (const t of [...(S?.times ?? [])].filter((x) => inMonth(x.date)).sort((a, b) => (a.at < b.at ? -1 : 1))) {
    const min = minutesOf(t.start, t.end);
    if (min === null) continue;
    const list = timesOn.get(t.date) ?? [];
    // 医療事務の値は、入れたときのその日の訪問の ref に結び付ける。訪問の記録がない日は日で結ぶ
    const e = t.ref !== null ? list.find((x) => x.ref === t.ref) : list.length === 1 ? list[0] : list.length === 0 ? undefined : null;
    if (e === null) continue;
    if (e) e.clerk = { min, by: t.by, at: t.at };
    else timesOn.set(t.date, [...list, { ref: t.ref, kind: null, ehr: null, clerk: { min, by: t.by, at: t.at } }]);
  }
  const timeKnown = (date: string) => (timesOn.get(date) ?? []).some((e) => e.ehr !== null || e.clerk !== null);
  const KAKA = new Set<string>([RULE_CODES.kakaVisit, RULE_CODES.kakaOushin, RULE_CODES.kakaOushinSpecial]);
  /** 規則で出す算定と同じコードの文章の行為（16-3）：規則がその日を見るときは規則の側にたたむ。見られないときは添え書きつきで今の候補に残す */
  const ruleFolded = new Set<ConfirmedAct>();
  if (S)
    for (const a of acts) {
      const m = a.act.match;
      if (!m || m.tbl !== "shinryo" || a.source === "structured") continue;
      if (KAKA.has(m.code)) {
        if (timeKnown(a.date)) ruleFolded.add(a);
        else extraNotes.set(a, [{ reason: "規則の項目が取れない", text: "時刻が分かれば規則で確かめます" }]);
      }
    }
  for (const a of acts) {
    const m = a.act.match;
    if (m && m.tbl === "shinryo" && a.act.category === "投薬" && a.source !== "structured" && inKubun(m.code, ["F0", "F100"]) && ruleDrugDay(a.date)) ruleFolded.add(a);
  }
  if (ruleFolded.size > 0) tally("規則で見る行為をたたみました", ruleFolded.size);
  // 材料加算のコードに当たった文章の行為は、候補にせず患者の情報の機器で見る（16-3。FR-208）。注入器加算・注入器用注射針加算は機器で見ないので、たたまない（L-181）
  const DEVICE_CODES = new Set<string>([...Object.values(DEVICE_KINDS).flatMap((d) => [...d.codes]), RULE_CODES.oxygenMaterial2]);
  let deviceFolded = 0;
  if (DV)
    for (const a of acts) {
      const m = a.act.match;
      if (m && m.tbl === "shinryo" && a.source !== "structured" && DEVICE_CODES.has(m.code) && !ruleFolded.has(a)) {
        ruleFolded.add(a);
        deviceFolded++;
      }
    }
  if (deviceFolded > 0) tally("患者の情報の機器で見る行為をたたみました", deviceFolded);

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
  const compare = (kind: G11Item["kind"], code: string, date: string, quantities: (string | undefined)[], label: { written: string; child?: string; parentCodes?: string[]; quote: string; noteIds: (number | undefined)[] }) => {
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
    const dayQty = (x: string) => info.same(x).reduce((s, y) => s + (idx.qty.get(y)?.[day - 1] ?? 0), 0);
    // 子の量は、請求の側も同じ日・同じ親の区分の単位の中で合計する（カルテの側と同じ単位。C-310・X-160）。親の単位に子がなければ、その日の全部の量
    const parentQty = (x: string, parents: string[]): number | null => {
      const ps = new Set(parents);
      const cs = new Set(info.same(x));
      let found = false;
      let total = 0;
      for (const u of claim.units) {
        const n = u.days?.[day - 1] ?? 0;
        if (n <= 0 || !u.items.some((it) => ps.has(it.code))) continue;
        for (const it of u.items) {
          if (!cs.has(it.code)) continue;
          found = true;
          const v = Number((it.quantity ?? "").trim());
          if (it.quantity !== undefined && it.quantity.trim() !== "" && Number.isFinite(v)) total += v * n;
        }
      }
      return found ? total : null;
    };
    const claimQty = (x: string) => (label.parentCodes ? (parentQty(x, label.parentCodes) ?? dayQty(x)) : dayQty(x));
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
  for (const a of acts) if (!ruleFolded.has(a)) byDay.set(a.date, [...(byDay.get(a.date) ?? []), a]);
  let unmatched = 0;
  const unmatchedActs: G11Unmatched[] = [];
  for (const [date, list] of [...byDay].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const day = Number(date.slice(8, 10));
    const r = rxDay.get(date);
    const drugs: ConfirmedAct[] = [];
    const procs: ConfirmedAct[] = [];
    // 同じ日・同じ区分の量を合計するため、先に集める（子は、同じ親の区分の中の同じ子の区分ごと。X-146・X-156）
    const qtyGroups = new Map<string, { kind: G11Item["kind"]; code: string; acts: ConfirmedAct[] }>();
    const childGroups: ChildGroups = new Map();
    for (const a of list) {
      const m = a.act.match;
      const at = a.noteId !== undefined && a.index !== undefined ? { noteId: a.noteId, index: a.index } : {};
      // 手技で使った薬・器材の当てられないものも並べる（親が当たっていても。X-161）
      (a.act.with ?? []).forEach((x, j) => {
        if (x.match) return;
        unmatched++;
        unmatchedActs.push({ date: a.date, written: x.written, category: a.act.category, ...at, child: { index: j, kind: x.kind, parent: a.act.written } });
      });
      if (!m) {
        unmatched++;
        unmatchedActs.push({ date: a.date, written: a.act.written, category: a.act.category, ...at });
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
          else regular(a, date, day, qtyGroups, childGroups);
        }
        continue;
      }
      regular(a, date, day, qtyGroups, childGroups);
    }
    for (const g of qtyGroups.values()) {
      const head = g.acts[0];
      compare(g.kind, g.code, date, g.acts.map((x) => x.act.quantity), { written: head.act.written, quote: [...new Set(g.acts.map((x) => x.act.quote))].sort().join("／"), noteIds: g.acts.map((x) => x.noteId) });
    }
    // 投薬の薬と手技（院内・院外の扱い。C-221・C-231・X-130）
    const od = orderDay(date);
    if (drugs.length + procs.length > 0 && od) {
      // オーダーを受け取っている月のオーダーの日：院内・院外はオーダーで決める（16-4-1。施設の申告・本人の選択は使わず、食い違いを添える）
      if (od.place === "inside") drugGroup(date, day, drugs, procs, mismatch(date, "inside"));
      else {
        if (drugs.length > 0)
          tally(od.place === "outside" ? "院外処方箋の日なので薬は見ていません" : od.place === "mixed" ? "同じ日に院内と院外のオーダーがある日の薬は見ていません" : "オーダーの院内・院外が欠けている日の薬は見ていません", drugs.length);
        for (const p of procs) regular(p, date, day, new Map(), childGroups);
      }
    } else if (drugs.length + procs.length > 0) {
      const n = drugs.length + procs.length;
      if (about.dispensing === "outside") {
        if (drugs.length > 0) tally("院外処方の施設なので薬は見ていません", drugs.length);
        for (const p of procs) regular(p, date, day, new Map(), childGroups);
      } else if (about.dispensing === "unknown") tally(UNKNOWN_DISPENSING[0], n, UNKNOWN_DISPENSING[1]);
      else if (!r || !r.rx) tally(`${Number(date.slice(5, 7))}月${md(date)}日は処方の記載がないので薬は見ていません`, n);
      else if (r.choice === "outside") {
        if (drugs.length > 0) tally("院外処方箋の日なので薬は見ていません", drugs.length);
        for (const p of procs) regular(p, date, day, new Map(), childGroups);
      } else if (r.choice !== "inside") undecidedDays.add(date);
      else drugGroup(date, day, drugs, procs);
    }
    for (const g of childGroups.values())
      compare(g.kind, g.code, date, g.items.map((x) => x.quantity), { written: g.parent, child: g.child, parentCodes: g.parentCodes, quote: [...new Set(g.items.map((x) => x.quote))].sort().join("／"), noteIds: g.items.map((x) => x.noteId) });
  }

  /** 投薬でない行為（と、院外の日の投薬の手技）：請求にないなら候補、あれば with の子と量を見る */
  function regular(a: ConfirmedAct, date: string, day: number, qtyGroups: Map<string, { kind: G11Item["kind"]; code: string; acts: ConfirmedAct[] }>, childGroups: ChildGroups) {
    const m = a.act.match!;
    const kind: G11Item["kind"] = m.tbl === "shinryo" ? "SI" : m.tbl === "iyakuhin" ? "IY" : "TO";
    const children = (a.act.with ?? []).filter((x) => x.match);
    const rep = (code: string, written: string, quote: string, tbl?: string): Report => ({ code, written, quote, noteId: a.noteId, name: nameOfCode(c, code), ...(tbl ? { tbl } : {}) });
    if (!present(m.code, day, isJudgement(m.code))) {
      const items: G11Item[] = [{ kind, code: m.code }, ...children.map((x) => ({ kind: (x.match!.tbl === "iyakuhin" ? "IY" : "TO") as G11Item["kind"], code: x.match!.code }))];
      add({ kind: "act", date, day, units: [unitOn(items, day)], report: [rep(m.code, a.act.written, a.act.quote, m.tbl)], ...(children.length > 0 ? { withNames: children.map((x) => x.written) } : {}) }, orderNotes([a]));
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
      else {
        // 量は、同じ日・同じ親の区分の中の同じ子の区分ごとに合計してから比べる（X-156）
        const k = `${key}|${ck}|${info.same(x.match!.code).sort().join(",")}`;
        const cg = childGroups.get(k) ?? { kind: ck, code: x.match!.code, parent: a.act.written, parentCodes: info.same(m.code), child: x.written, items: [] };
        cg.items.push({ quantity: x.quantity, quote: x.quote, noteId: a.noteId });
        childGroups.set(k, cg);
      }
    }
  }

  /** 投薬の組（院内の日。X-130・C-221）：その日の薬・書かれた投薬の手技と、剤形から決まる調剤料・処方料を 1 つの候補にする */
  function drugGroup(date: string, day: number, drugs: ConfirmedAct[], procs: ConfirmedAct[], extra: Note[] = []) {
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
    add({ kind: "drugs", date, day, units: unitsOfGroup, report: missing.map((a) => ({ code: a.act.match!.code, written: a.act.written, quote: a.act.quote, noteId: a.noteId, name: nameOfCode(c, a.act.match!.code) })) }, [...orderNotes(missing), ...extra]);
  }

  // 2. 決まった規則で足す候補（M-1。X-147）：判断料と処方箋料
  {
    const kensa = db.prepare("SELECT code FROM shinryo WHERE snapshot = ? AND kensa_kind = '2' AND kensa_group = ?");
    // 根拠は、その月の請求と確かめた行為にある検体検査の項目（X-158）。claim は請求にある項目（コードと最初の算定日。算定日の分からない単位だけなら null）
    const groups = new Map<number, { acts: ConfirmedAct[]; claim: { code: string; day: number | null }[] }>();
    const groupOf = (code: string): number | null => {
      const r = shinryoOf(db, c.snapshot.si, code);
      return r && r.kensa_kind === "1" && JUDGEMENT_GROUPS.includes(r.kensa_group) ? r.kensa_group : null;
    };
    const groupEntry = (g: number) => groups.get(g) ?? { acts: [], claim: [] };
    for (const a of acts) {
      const m = a.act.match;
      if (!m || m.tbl !== "shinryo") continue;
      const g = groupOf(m.code);
      if (g === null) continue;
      const e = groupEntry(g);
      groups.set(g, { ...e, acts: [...e.acts, a] });
    }
    for (const code of [...new Set([...idx.days.keys(), ...idx.untimed])].sort()) {
      const g = groupOf(code);
      if (g === null) continue;
      const first = (idx.days.get(code) ?? []).findIndex((n) => n > 0);
      const e = groupEntry(g);
      groups.set(g, { ...e, claim: [...e.claim, { code, day: first >= 0 ? first + 1 : null }] });
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
      const name = nameOfCode(c, code);
      if (g.acts.length === 0) {
        // 請求にある項目だけから決まる判断料（X-158）：日は請求の最初の算定日、引用はない。
        // 算定日の分かる項目がなければ、日を付けずに月で扱う（日は 0、診療年月を日付の代わりにし、足す単位は算定日の分からない単位。X-162）
        const timed = g.claim.flatMap((x) => (x.day === null ? [] : [x.day]));
        const day = timed.length > 0 ? Math.min(...timed) : 0;
        const date = day > 0 ? `${about.yearMonth}-${String(day).padStart(2, "0")}` : about.yearMonth;
        const u = day > 0 ? unitOn([{ kind: "SI", code }], day) : { items: [{ kind: "SI" as const, code }], count: 1, days: zeros(), day: 0 };
        add({ kind: "derived", date, day, units: [u], report: [{ code, written: name, quote: "", name }], derived: { what: [...new Set(g.claim.map((x) => `『${nameOfCode(c, x.code)}』`))].join("・"), basis: "マスターの検査のグループ", name, fromClaim: true } });
        continue;
      }
      const first = g.acts.map((a) => a.date).sort()[0];
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
      // オーダーのある日は、オーダーで決める（16-4-4。下の規則の候補）
      if (!r.date.startsWith(`${about.yearMonth}-`) || !r.rx || info.rxPrimary === null || ordersOn.has(r.date)) continue;
      if (!((about.dispensing === "inside" && r.choice === "outside") || about.dispensing === "outside")) continue;
      const day = Number(r.date.slice(8, 10));
      if (rxPresent(day) || acts.some((a) => a.date === r.date && a.act.match && info.rxCodes.has(a.act.match.code))) continue;
      const quote = (byDay.get(r.date) ?? []).find((a) => a.act.category === "投薬")?.act.quote ?? "";
      add({ kind: "derived", date: r.date, day, units: [unitOn([{ kind: "SI", code: info.rxPrimary }], day)], report: [{ code: info.rxPrimary, written: "処方箋料", quote, name: "処方箋料" }], derived: { what: "処方の記載", basis: "処方の記載", name: "処方箋料" } });
    }
  }

  // 2b. 規則の候補（design.md §16-4。段 19c・19d）：処方のオーダー・処方の欄の「確かめた」の印・訪問の記録から、決まった規則で出す。言い切らず、手順 1〜4 に通す
  const ruleScope: string[] = [];
  const ruleGuides: string[] = [];
  const visitTimeDays: string[] = [];
  const dayList = (dates: Iterable<string>) => [...new Set(dates)].sort().map((d) => `${md(d)}日`).join("・");
  const ruleCand = (date: string, units: AddedUnit[], rc: RuleCand, notes: Note[] = [], alt?: AddedUnit[]) =>
    add({ kind: "rule", date, day: Number(date.slice(8, 10)) || 0, units, ...(alt ? { alt } : {}), rule: rc, report: [{ code: units[0].items[0].code, written: rc.label, quote: rc.dayQuote, name: rc.label }] }, notes);
  const si1 = (code: string, day: number, quantity?: string) => unitOn([{ kind: "SI", code, ...(quantity !== undefined ? { quantity } : {}) }], day);
  const EHR = "電子カルテ";
  const zaikeiOf = (code: string) => (c.snapshot.iy ? iyakuhinOf(db, c.snapshot.iy, code)?.zaikei : undefined);
  {
    // 麻薬等の区分（E-12 の錨のあとの医薬品マスターの列）。列を読めないマスターでは麻薬等加算を見ない（L-174）
    const mayakuReadable = c.snapshot.iy !== null && (db.prepare("PRAGMA table_info(iyakuhin)").all() as { name: string }[]).some((x) => x.name === "mayaku");
    const mayakuOf = (code: string): string | null =>
      mayakuReadable ? ((db.prepare("SELECT mayaku FROM iyakuhin WHERE snapshot = ? AND code = ?").get(c.snapshot.iy, code) as { mayaku: string } | undefined)?.mayaku ?? null) : null;
    const NARCOTIC = new Set(["1", "2", "3", "5"]);
    let mayakuUnread = 0;
    let formUnread = 0;
    const dates = [...new Set([...ordersOn.keys(), ...(about.rxDays ?? []).filter((r) => inMonth(r.date)).map((r) => r.date)])].sort();
    for (const date of dates) {
      const day = Number(date.slice(8, 10));
      const od = orderDay(date);
      // 院内の日（T1〜T4）：オーダーの院内の日、またはオーダーのない日で「確かめた」の印のある院内の日（L-199 (a)）
      let codes: string[] = [];
      let names: string[] = [];
      let notes: Note[] = [];
      let basis: RuleBasis["basis"];
      if (od?.place === "inside") {
        const items = orderDrugs(od.inside);
        formUnread += items.filter((x) => x.code === null).length;
        codes = items.flatMap((x) => (x.code !== null && x.tbl === "iyakuhin" ? [x.code] : []));
        names = items.map((x) => x.name);
        notes = [...mismatch(date, "inside"), ...(od.inside.length >= 2 ? [{ reason: "規則の添え書き" as const, text: `同じ日にオーダーが ${od.inside.length} 件あります。別々の処方なら回数が増えます（明文なし。EM U-50）` }] : [])];
        basis = "order";
      } else if (!od && confirmedInside(date)) {
        const ds = acts.filter((a) => a.date === date && a.act.category === "投薬" && a.act.match?.tbl === "iyakuhin");
        codes = ds.map((a) => a.act.match!.code);
        names = ds.map((a) => a.act.written);
        basis = "chart";
      } else {
        if (od?.place === "blank") tally("オーダーの院内・院外が欠けているので、調剤料・処方料は見ていません");
        continue;
      }
      const forms = new Set<string>();
      let narcotic = false;
      for (const code of codes) {
        const z = zaikeiOf(code);
        if (z === ORAL || z === EXTERNAL) forms.add(z);
        if (NARCOTIC.has(mayakuOf(code) ?? "")) narcotic = true;
      }
      // 剤形が内服・外用の薬がない日（自己注射の薬だけなど）は出さない（L-111。GK-R8-02-Q65）
      if (forms.size === 0) continue;
      const B: RuleBasis = { basis, sources: [basis === "order" ? EHR : "本人が確かめた処方の欄"] };
      const rc = (key: string, label: string, requirement: string): RuleCand => ({ key, label, basisLabel: basis === "order" ? "オーダー" : "処方の欄で院内と確かめた日", requirement, basis: B, dayQuote: names.join("・") });
      if (forms.has(ORAL) && !present(RULE_CODES.chozaiOral, day)) ruleCand(date, [si1(RULE_CODES.chozaiOral, day)], rc("chozai-oral", "調剤料（内服薬・浸煎薬・屯服薬）", "院内で投薬した 1 回の処方につき 1 回算定します（R8-237）"), notes);
      if (forms.has(EXTERNAL) && !present(RULE_CODES.chozaiExternal, day)) ruleCand(date, [si1(RULE_CODES.chozaiExternal, day)], rc("chozai-external", "調剤料（外用薬）", "院内で投薬した 1 回の処方につき 1 回算定します（R8-237）"), notes);
      // 処方料は区分を決めない 1 件。請求にその日の F100 のどれかの区分があれば出さない（L-173）。手順 1 は両方の区分が抑えられたときだけ隠す
      if (!kubunOnDay(["F100"], day))
        ruleCand(date, [si1(RULE_CODES.shohoryo3, day)], rc("shohoryo", "処方料", "1 回の処方につき 1 回算定します。区分は内服の種類・向精神薬の長期処方と多剤投与で決まります（R8-240）"), notes, [si1(RULE_CODES.shohoryo2, day)]);
      if (!mayakuReadable) mayakuUnread++;
      else if (narcotic) {
        const missing = [RULE_CODES.mayakuChozai, RULE_CODES.mayakuShohoryo].filter((code) => !present(code, day));
        if (missing.length > 0) ruleCand(date, [unitOn(missing.map((code) => ({ kind: "SI" as const, code })), day)], rc("mayaku", "麻薬等加算（調剤料・処方料）", "麻薬・向精神薬・覚醒剤原料・毒薬を処方・調剤した 1 処方につき 1 回ずつ算定します（R8-238）"), notes);
      }
    }
    if (formUnread > 0) tally("調剤料・処方料は、オーダーの薬のコードが判定の外で剤形を読めない分を見ていません", formUnread);
    if (mayakuUnread > 0) tally("麻薬等の区分を医薬品マスターから読めないので、麻薬等加算は見ていません", mayakuUnread);

    // 処方箋料（T5）：オーダーの院外の日。同じ日に院内と院外のオーダーがある日は、調剤料・処方料を出さず、処方箋料に R8-239 の添え書き
    for (const [date] of [...ordersOn].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const od = orderDay(date)!;
      if ((od.place !== "outside" && od.place !== "mixed") || info.rxPrimary === null) continue;
      const day = Number(date.slice(8, 10));
      // 確かめた行為に処方箋料がその日にあれば、そちらで言う（1 つにまとめる。X-147）
      if (rxPresent(day) || acts.some((a) => a.date === date && a.act.match && info.rxCodes.has(a.act.match.code))) continue;
      const notes: Note[] = [
        ...mismatch(date, "outside"),
        ...(od.place === "mixed" ? [{ reason: "規則の添え書き" as const, text: "同じ日に院内と院外のオーダーがあります。原則認められず、緊急やむを得ない場合は調剤料・処方料を算定せず、摘要欄に日付と理由を書きます（R8-239）" }] : []),
      ];
      ruleCand(date, [si1(info.rxPrimary, day)], { key: "shohosen", label: "処方箋料", basisLabel: "オーダー", requirement: "院外処方箋を交付した日に算定します（R8-236）", basis: { basis: "order", sources: [EHR] }, dayQuote: orderDrugs(od.outside).map((x) => x.name).join("・") }, notes);
    }
  }

  // 在医総管 注2（T6。16-4-5）：在医総管の月で、全部の条件を満たすときだけ。確かめられないときは理由ごとに「見ていません」
  if (S) {
    const kanriCodes = new Set(rev.consts.kanri.rows.flatMap((r) => kubunCodes(r.kubun)));
    const kanriMonth = [...kanriCodes].some((x) => idx.untimed.has(x) || (idx.days.get(x) ?? []).some((n) => n > 0));
    const n2Codes = kubunCodes(rev.consts.bundled.noRxAddition);
    const n2Present = n2Codes.some((x) => idx.untimed.has(x) || (idx.days.get(x) ?? []).some((n) => n > 0));
    const textsNow = S.texts.filter((x) => inMonth(x.date));
    const writtenRx = (date: string) => acts.some((a) => a.date === date && a.source !== "structured" && a.act.match && info.rxCodes.has(a.act.match.code));
    // 院外を示す日（当月）：院外の語の規則に当たる、本人が院外を選んだ、確かめた文章の行為が処方箋料の区分に当たった
    const outsideDays = new Set<string>([
      ...textsNow.filter((x) => isOutsideText(x.text)).map((x) => x.date),
      ...(about.rxDays ?? []).filter((r) => inMonth(r.date) && r.choice === "outside").map((r) => r.date),
      ...acts.filter((a) => writtenRx(a.date)).map((a) => a.date),
    ]);
    // オーダーのない処方の日（当月）：処方の記載か、文章にだけある薬がある日（16-4-1）
    const textDrugDays = acts.filter((a) => a.source !== "structured" && a.act.category === "投薬" && a.act.match?.tbl === "iyakuhin").map((a) => a.date);
    const orderless = [...new Set([...(about.rxDays ?? []).filter((r) => inMonth(r.date) && r.rx).map((r) => r.date), ...textDrugDays])].filter((d) => !ordersOn.has(d)).sort();
    if (kanriMonth && !n2Present) {
      const reasons: string[] = [];
      let blocked = false;
      let insideN = 0;
      const unconfirmed: string[] = [];
      if (!orderMonth) reasons.push("処方のオーダーを受け取っていない");
      else {
        const monthOrders = [...ordersOn.values()].flat();
        // 院外のオーダーがその月に 1 件でもあれば出さない（R8-241 (c)）
        if (monthOrders.some((o) => o.place === "院外")) blocked = true;
        insideN = monthOrders.filter((o) => o.place === "院内").length;
        const blankDays = [...ordersOn].filter(([, os]) => os.some((o) => o.place === null)).map(([d]) => d);
        unconfirmed.push(...blankDays);
        // 投薬のない月は出さない（U-52。照会 #19。L-175）
        if (insideN === 0 && orderless.length === 0 && blankDays.length === 0) reasons.push("投薬のない月（照会中）");
        else if (insideN === 0) reasons.push("院内のオーダーがない（オーダーのない処方の日だけの月）");
        // (d) 30 日を超える院外処方の投与期間がこの月にかからないか：前の lookbackMonths か月のオーダーで確かめる（L-201）
        const first = `${ym}-01`;
        const endOf = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + (days - 1) * 86400000).toISOString().slice(0, 10);
        let unreadable = 0;
        let noDays = 0;
        let refill = 0;
        let unknownPeriod = 0;
        for (const h of S.history) {
          if (!h.orders || h.orders.status !== "supported") {
            unreadable++;
            continue;
          }
          const outsideDates = new Set(h.orders.items.filter((o) => o.place === "院外").map((o) => o.date));
          for (const o of h.orders.items) {
            if (o.place === null) {
              unreadable++;
              continue;
            }
            if (o.place !== "院外") continue;
            // リフィル：回数 2 以上をリフィルとみなすかは EM にない。接続先が回数を返さない（null）ときと、設計に定めのない回数 1 も分からないので、どれも「見ていません」に数える（L-201 の既定。C-430）
            if (o.refills === null || o.refills >= 1) refill++;
            o.drugs.forEach((d, i) => {
              if (d.days === null) {
                // 日数の欠け：内服（剤形 1）やコードの当たらない薬は読めない。外用・頓服など日数を持たない薬は「日数のない院外処方」（L-201 (2)）
                const it = h.items.find((x) => x.ref === `${o.ref}/${i}`);
                const z = it?.code ? zaikeiOf(it.code) : undefined;
                if (!it?.code || z === ORAL) unreadable++;
                else noDays++;
              } else if (d.days > 30 && endOf(o.date, d.days) >= first) blocked = true;
            });
          }
          // 範囲の中の文章：院外を示す日で、その日に院外のオーダーがないもの（期間が分からない。文章から日数を読んで決めない。X-241）
          for (const x of S.texts.filter((y) => y.date.startsWith(`${h.yearMonth}-`)))
            if ((isOutsideText(x.text) || x.choice === "outside" || x.rxAct === true) && !outsideDates.has(x.date)) unknownPeriod++;
        }
        if (unreadable > 0) reasons.push("前の処方を読めない");
        if (unknownPeriod > 0) reasons.push(`期間の分からない院外処方：${unknownPeriod} 日`);
        if (noDays + refill > 0) reasons.push(`日数のない・リフィルの院外処方：${noDays + refill} 件`);
      }
      // (e) 文章との照らし合わせ（当月の全部の日。L-206・L-211）
      const visitDates = new Set<string>([
        ...(S.chart.visits.status === "supported" ? S.chart.visits.items.filter((v) => inMonth(v.date)).map((v) => v.date) : []),
        ...codeDays([...rev.consts.visitKubun, rev.consts.oushin.kubun, rev.consts.oushin.revisit].flatMap(kubunCodes)),
        ...textsNow.map((x) => x.date),
        ...acts.filter((a) => a.source !== "structured").map((a) => a.date),
      ]);
      const textDates = new Set(textsNow.map((x) => x.date));
      // カルテを 1 日も持たない請求では、注2 だけを回さない（16-4-5 (e)。調剤料・処方料はオーダーで出す）
      if (textDates.size === 0) reasons.push("カルテの文章がない月");
      const noText = [...visitDates].filter((d) => !textDates.has(d));
      if (noText.length > 0) reasons.push(`カルテの文章のない訪問の日：${noText.length} 日`);
      if (outsideDays.size > 0) reasons.push(`文章に院外処方箋の記載：${outsideDays.size} 日`);
      const facilityOutside: string[] = [];
      for (const d of orderless) {
        if (outsideDays.has(d)) continue;
        const r = rxDay.get(d);
        if (about.dispensing === "outside") facilityOutside.push(d);
        else if (!(r?.confirmed && r.choice === "inside")) unconfirmed.push(d);
      }
      if (unconfirmed.length > 0) reasons.push(`院内・院外が確かめられていない日：${new Set(unconfirmed).size} 日`);
      if (facilityOutside.length > 0) reasons.push(`施設の申告は院外処方だけ：オーダーのない処方の日 ${facilityOutside.length} 日`);
      // (e2) 請求の処方箋料（X-251）
      const f400 = kubunDays(["F400"]);
      if (f400 > 0) reasons.push(`請求に処方箋料があり、院外のオーダーと食い違います：${f400} 日`);
      const mismatchDays = [...outsideDays].filter((d) => orderDay(d)?.place === "inside");
      if (!blocked) {
        const label = "処方箋を交付しない場合の加算";
        if (reasons.length > 0) {
          for (const r of reasons) ruleScope.push(`${label}は見ていません（${r}）`);
          if (mismatchDays.length > 0) ruleScope.push(`文章に院外処方箋の記載があり、オーダーは院内の日（食い違い）：${dayList(mismatchDays)}`);
          if (orderMonth && unconfirmed.length > 0) ruleGuides.push(`${dayList(unconfirmed)}の処方の院内・院外を確かめると、${label}を見ます`);
        } else if (insideN > 0 && n2Codes.length > 0) {
          const firstInside = [...ordersOn].filter(([, os]) => os.some((o) => o.place === "院内")).map(([d]) => d).sort()[0];
          ruleCand(firstInside, [si1(n2Codes[0], Number(firstInside.slice(8, 10)))], {
            key: "n2",
            label,
            basisLabel: "オーダー",
            requirement: `在医総管の月で、院外処方箋を交付していない月に算定します（R8-241）。当月にかかる 30 日を超える院外処方は、前の ${S.lookbackMonths} か月のオーダーで確かめました`,
            basis: { basis: "order", sources: [EHR] },
            dayQuote: `院内のオーダー ${insideN} 件・院外のオーダー 0 件`,
          });
        }
      }
    }
    // 処方の日の「確かめた」の印の案内（16-6。効く日だけ）：オーダーを受け取っていない、在医総管のない月の、初期値が院内の日（L-199 (a)）
    if (!orderMonth && !kanriMonth && about.dispensing === "inside") {
      const ds = (about.rxDays ?? []).filter((r) => inMonth(r.date) && r.rx && r.choice === "inside" && !r.confirmed).map((r) => r.date);
      if (ds.length > 0) ruleGuides.push(`${dayList(ds)}の処方の院内を確かめると、調剤料・処方料を見ます`);
    }
  } else if (about.dispensing === "inside") {
    // 構造化データのない請求（オーダーを受け取っていない月）でも、在医総管のない月の、初期値が院内の日には印の案内を出す（L-199 (a)）
    const kanriCodes = new Set(rev.consts.kanri.rows.flatMap((r) => kubunCodes(r.kubun)));
    const kanriMonth = [...kanriCodes].some((x) => idx.untimed.has(x) || (idx.days.get(x) ?? []).some((n) => n > 0));
    const ds = (about.rxDays ?? []).filter((r) => inMonth(r.date) && r.rx && r.choice === "inside" && !r.confirmed).map((r) => r.date);
    if (!kanriMonth && ds.length > 0) ruleGuides.push(`${dayList(ds)}の処方の院内を確かめると、調剤料・処方料を見ます`);
  }

  // 患家診療時間加算（T7。16-4-6）：記録の時刻の差が 61 分以上で、その日の基本の行（訪問診療料・往診料）が請求か候補にある日。基本の行がなく初診料・再診料がある日は 2 人目以降の添え書きつき
  if (S) {
    const visitSet = new Set(rev.consts.visitKubun.flatMap(kubunCodes));
    const oushinSet = new Set(kubunCodes(rev.consts.oushin.kubun));
    const candHas = (set: Set<string>, day: number) => cands.some((x) => x.day === day && x.kind !== "qty" && x.kind !== "rule" && x.units.some((u) => u.items.some((it) => set.has(it.code))));
    const baseOf = (set: Set<string>, day: number) => codesOnDay(set, day) || candHas(set, day);
    const claimVisitDays = codeDays([...visitSet, ...oushinSet]);
    const days = [...new Set([...timesOn.keys(), ...claimVisitDays])].sort();
    let unknown = 0;
    let noBase = 0;
    let unknownKind = 0;
    const guideDays: string[] = [];
    // 時間の語の規則は S・O・A・P だけに掛ける（処方の欄は掛けない。C-444）
    const confirmedText = (date: string) => S.texts.filter((x) => x.date === date && x.confirmed).map((x) => x.soap).join("\n");
    for (const date of days) {
      const day = Number(date.slice(8, 10));
      const entries = timesOn.get(date) ?? [];
      if (!entries.some((e) => e.ehr !== null || e.clerk !== null)) {
        unknown++;
        if (hasTimeHint(confirmedText(date)) || codesOnDay(KAKA, day)) guideDays.push(date);
        continue;
      }
      // 種類：訪問の記録の種類。記録がない（医療事務の値だけの）日は、その日の基本の行で決める
      const kindOf = (e: TimeEntry) => e.kind ?? (baseOf(visitSet, day) ? "訪問診療" : baseOf(oushinSet, day) ? "往診" : null);
      // 種類が決まらない時刻（基本の行がない日。同じ患家の 2 人目以降の初診料・再診料だけの日など）は、黙って消さず「見ていません」に数える（C-432。16-4-6）
      if (entries.some((e) => kindOf(e) === null && (e.ehr !== null || e.clerk !== null))) {
        if (kubunOnDay(["A0", "A1"], day)) unknownKind++;
        else noBase++;
      }
      for (const kind of ["訪問診療", "往診"] as const) {
        const es = entries.filter((e) => kindOf(e) === kind && (e.ehr !== null || e.clerk !== null));
        if (es.length === 0) continue;
        const set = kind === "訪問診療" ? visitSet : oushinSet;
        const base = baseOf(set, day);
        const second = !base && kubunOnDay(["A0", "A1"], day);
        if (!base && !second) {
          noBase++;
          continue;
        }
        const code = kind === "訪問診療" ? RULE_CODES.kakaVisit : RULE_CODES.kakaOushin;
        if (codesOnDay(kind === "訪問診療" ? [RULE_CODES.kakaVisit] : [RULE_CODES.kakaOushin, RULE_CODES.kakaOushinSpecial], day)) continue;
        const sources = [...new Set(es.flatMap((e) => [...(e.ehr !== null ? [EHR] : []), ...(e.clerk ? [`医療事務が入れた（${e.clerk.by}・${e.clerk.at}）`] : [])]))];
        const notes: Note[] = second ? [{ reason: "規則の添え書き", text: "同じ患家の 2 人目以降として出しました。2 人目以降でなければ、訪問診療料・往診料を確かめてください。摘要欄の記載（820100847）が要ります" }] : [];
        let quote: string;
        let quantity: string;
        let qty: number;
        if (es.length >= 2) {
          // 同じ日に同じ患者へ 2 回（U-38）：回ごとと合算を並べ、どちらで数えるかは決めない（L-202）
          const per = es.map((e) => e.ehr ?? e.clerk!.min);
          const sum = per.reduce((s, n) => s + n, 0);
          if (per.every((n) => n <= 60) && sum <= 60) continue;
          quote = `回ごと ${per.map((n) => `${n} 分`).join("・")}、合算 ${sum} 分`;
          quantity = `回ごと ${per.join("・")} 分／合算 ${sum} 分`;
          qty = Math.max(...per.filter((n) => n > 60), sum);
          notes.push({ reason: "規則の添え書き", text: `回ごとと合算のどちらで数えるかは明文がありません（U-38）${per.every((n) => n <= 60) ? "。回ごとではどちらも 60 分以下です" : ""}` });
        } else {
          const e = es[0];
          const vals = [e.ehr, e.clerk?.min ?? null];
          if (vals[0] !== null && vals[1] !== null && vals[0] !== vals[1]) {
            // 電子カルテと医療事務の値が違う：両方を並べ、どちらかが 61 分以上なら出す（L-178。決めない）
            if (Math.max(vals[0], vals[1]) <= 60) continue;
            quote = `電子カルテでは ${vals[0]} 分、医療事務が入れた値では ${vals[1]} 分`;
            quantity = `${vals[0]} 分／${vals[1]} 分`;
            qty = Math.max(vals[0], vals[1]);
          } else {
            const v = (vals[0] ?? vals[1])!;
            if (v <= 60) continue;
            quote = `記録の時刻では ${v} 分です`;
            quantity = `${v}`;
            qty = v;
          }
        }
        ruleCand(
          date,
          [si1(code, day, String(qty))],
          {
            key: `kaka-${kind}`,
            label: `患家診療時間加算（${kind}）`,
            basisLabel: "訪問の記録",
            requirement: "診療に当たっていた時間（移動・待ちの時間を除く）として合っているか確かめてください（R8-204）。同じ患家の 2 人目以降なら摘要欄の記載（820100847）が要ります。訪問診療の 3 人目以降は明文が 2 人目です（U-40）",
            basis: { basis: "visit", sources },
            dayQuote: quote,
            quantity,
          },
          notes,
        );
      }
    }
    if (unknown > 0) ruleScope.push(`患家診療時間加算は見ていません（時刻の分からない訪問の日：${unknown} 日）`);
    if (unknownKind > 0) ruleScope.push(`患家診療時間加算は見ていません（訪問の種類が分からない日：${unknownKind} 日）`);
    if (noBase > 0) ruleScope.push(`訪問診療料・往診料・初診料・再診料のない日の時間の加算は見ていません：${noBase} 日`);
    if (guideDays.length > 0) ruleGuides.push(`${dayList(guideDays)}の訪問の開始・終了の時刻を入れると、患家診療時間加算を見ます`);
    visitTimeDays.push(...guideDays);
  }

  // 在宅療養指導管理材料加算（T8〜T15。16-4-7）：患者の機器の行だけから出す。請求に「ある」は EM の区分と組の単位で見る（C-401）。前の 2 か月の請求のコメントで当月分を見る（C-411）
  const materialNotes: string[] = [];
  const mismatchFindings: G11Finding[] = [];
  if (DV) {
    const dv = DV;
    materialNotes.push("注入器加算・注入器用注射針加算は見ていません", "ほかの医療機関が在宅療養指導管理料を算定している患者かは見ていません");
    const inClaim = (codes: Iterable<string>) => [...codes].filter((x) => idx.untimed.has(x) || (idx.days.get(x) ?? []).some((n) => n > 0));
    const nameOf = (code: string) => shinryoOf(db, c.snapshot.si, code)?.name ?? code;
    const shift = (m: string, n: number) => {
      const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1));
      return d.toISOString().slice(0, 7);
    };
    // 機器の案内（16-6）：確かめていない患者で、その月の請求か確かめた行為に、在宅療養指導管理料（C100〜C121）か材料加算のコードがある
    const kanriLike = (code: string) => {
      const k = kubunNoOf(code);
      const n = k && k.startsWith("C") ? Number(k.slice(1)) : NaN;
      return (n >= 100 && n <= 121) || DEVICE_CODES.has(code);
    };
    if (!dv.checked) {
      tally("在宅療養指導管理材料加算は、機器を確かめていない患者なので見ていません");
      const touched = [...idx.days.keys(), ...idx.untimed].some(kanriLike) || acts.some((a) => a.act.match?.tbl === "shinryo" && kanriLike(a.act.match.code));
      if (touched) ruleGuides.push("患者の情報で在宅療養の機器を確かめると、在宅療養指導管理材料加算を見ます");
    } else {
      const pendingKinds = new Set(dv.pending);
      const pendingAny = dv.pending.includes(null);
      if (dv.pending.length > 0) ruleGuides.push(`電子カルテから届いた機器の変える案が ${dv.pending.length} 件あります。患者の情報で入れるか決めてください`);
      const missingPrev = [1, 2].map((n) => shift(ym, -n)).filter((m) => !dv.prev.some((p) => p.yearMonth === m));
      /** 前の 2 か月の請求で、その単位のどれかのコードと対象の月のコメントがあり、対象の月に当月が入るコード */
      const prevCovered = (codes: string[]): string[] => {
        const out = new Set<string>();
        for (const p of dv.prev)
          for (const u of p.units) {
            const hit = u.codes.filter((x) => codes.includes(x));
            if (hit.length === 0) continue;
            if (u.comments.some((cm) => Object.hasOwn(MATERIAL_MONTH_COMMENTS, cm) && shift(p.yearMonth, MATERIAL_MONTH_COMMENTS[cm]) === ym)) hit.forEach((x) => out.add(x));
          }
        return [...out];
      };
      const EHR_CHECKED = "電子カルテ（確かめた）";
      type Dev = { kind: DeviceKey; code: string; label: string; row: G11Devices["rows"][number] };
      const devs: Dev[] = [];
      for (const r of dv.rows) {
        const code = codeOfDevice(r);
        if (code === null) {
          tally("血糖自己測定器加算は、機器の行の区分か患者の区分が空なので見ていません");
          continue;
        }
        devs.push({ kind: r.kind, code, label: nameOf(code), row: r });
      }
      const notesFor = (d: Dev): Note[] => {
        const out: Note[] = [];
        if (OXYGEN_KINDS.includes(d.kind)) out.push({ reason: "規則の添え書き", text: "チアノーゼ型先天性心疾患の患者には算定しません" });
        if (d.kind === "C160") out.push({ reason: "規則の添え書き", text: "保険薬局が輸液セットを出していれば算定しません（R8-210）" });
        if (d.kind === "C161") out.push({ reason: "規則の添え書き", text: "対象の療法（R8-218 のイ〜ホ）に当たるか確かめてください" });
        if (d.kind === "C162") out.push({ reason: "規則の添え書き", text: "C105 の対象（成分栄養。単なる流動食は当たらない）か確かめてください" });
        if (d.kind === "C150") out.push({ reason: "規則の添え書き", text: "指示の回数で区分を選びました（U-46）" });
        if ((d.kind === "C161" || d.kind === "C166") && devs.some((x) => x.kind === (d.kind === "C161" ? "C166" : "C161"))) out.push({ reason: "規則の添え書き", text: "同じ月の併算定は明文がありません（U-48）" });
        if (pendingKinds.has(d.kind) || pendingAny) out.push({ reason: "規則の添え書き", text: "電子カルテから確かめていない変える案があります" });
        if (missingPrev.length > 0) out.push({ reason: "規則の添え書き", text: "前の月に当月分を算定していないか確かめてください" });
        return out;
      };
      const sourceOf = (r: G11Devices["rows"][number]) => (r.source === EHR_CHECKED ? EHR_CHECKED : r.source);
      const requirementOf = (em: string) => `患者の情報の在宅療養の機器が診療年月に効いています。医療機関が提供した機器を在宅で使っている月に、3 月に 3 回まで算定します（${em}・R8-208・R8-210）`;
      const dayUnit = (codes: string[]): AddedUnit => ({ items: codes.map((code) => ({ kind: "SI" as const, code })), count: 1, days: zeros(), day: 0 });
      const deviceCand = (group: Dev[], key: string) => {
        const [first, ...rest] = group;
        const label = group.map((d) => d.label).join("・");
        const em = [...new Set(group.map((d) => DEVICE_KINDS[d.kind].em))].join("・");
        const notes = [...new Map(group.flatMap(notesFor).map((n) => [n.text, n])).values()];
        ruleCand(
          ym,
          [dayUnit([first.code])],
          {
            key,
            label: group.length > 1 ? `${label}のどれか 1 つ` : label,
            basisLabel: "患者の機器",
            requirement: group.length > 1 ? `1 か月にどれか 1 つを算定します（${em}）。どれで算定するか、算定できるかを確かめてください` : requirementOf(em),
            basis: { basis: "device", sources: [...new Set(group.map((d) => sourceOf(d.row)))] },
            dayQuote: group.map((d) => `${d.label}（${d.row.fromMonth} の診療月から）`).join("・"),
            ...(group.length > 1 ? { either: group.map((d) => d.code) } : {}),
          },
          notes,
          rest.length > 0 ? rest.map((d) => dayUnit([d.code])) : undefined,
        );
      };
      // 酸素の組 (a)：酸素濃縮装置が効く月は、酸素ボンベ 2 を出さない（R8-216 (a)。告示）
      const hasC158 = devs.some((d) => d.kind === "C158");
      const live = devs.filter((d) => !(hasC158 && d.kind === "C157_2"));
      if (hasC158 && live.length < devs.length) tally("酸素濃縮装置加算の月なので、酸素ボンベ加算（携帯用以外）は出しません（R8-216）");
      // 単位ごとにまとめる（単位にない機器は 1 つずつ）
      const groups = new Map<string, Dev[]>();
      for (const d of live) {
        const u = unitOfDevice(d.kind);
        const key = u.name ?? d.kind;
        groups.set(key, [...(groups.get(key) ?? []), d]);
      }
      for (const [key, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const unitCodes = unitOfDevice(group[0].kind).codes;
        // 請求に同じ単位のどれかがある：同じコードなら出さない。違えば食い違いの 1 件（2 つ目を勧めない。点数の高い側へ直さない。L-207）
        const claimed = inClaim(unitCodes);
        if (claimed.length > 0) {
          const devCodes = group.map((d) => d.code);
          if (claimed.some((x) => devCodes.includes(x))) continue;
          const claimLabel = claimed.map(nameOf).join("・");
          const devLabel = group.map((d) => d.label).join("・");
          mismatchFindings.push({
            messageKey: "G11.missing_rule",
            certainty: "条件つき",
            codes: [...claimed, ...devCodes],
            text: `患者の機器では${devLabel}、請求は${claimLabel}です。どちらが正しいか確かめてください`,
            days: [{ date: ym, quote: group.map((d) => `${d.label}（${d.row.fromMonth} の診療月から）`).join("・"), notes: [{ reason: "規則の添え書き", text: "同じ組の別の区分が請求にあります（R8-216・R8-221・R8-226）" }] }],
            caution: true,
            source: { data: "chart", ref: "note=" },
            rule: { basis: "device", sources: [...new Set(group.map((d) => sourceOf(d.row)))] },
          });
          continue;
        }
        // 前の 2 か月の請求で当月分が算定済み（同じ単位のどれかのコード。C-411）
        const covered = prevCovered(unitCodes);
        if (covered.length > 0) {
          const coveredLabel = covered.map(nameOf).join("・");
          if (group.some((d) => d.kind === "C150")) ruleScope.push(`前の月に${coveredLabel}を算定済み。月ごとの区分は明文がありません`);
          else if (!covered.some((x) => group.some((d) => d.code === x))) ruleScope.push(`前の月に${coveredLabel}で当月分を算定済みです`);
          continue;
        }
        // 「どれか 1 つ」：酸素の組 (b)(c)・人工呼吸器（W-18・R8-226）。ほかの単位（同じコードで見る機器）は 1 つずつ
        if (key === "酸素の組 (b)" || key === "酸素の組 (c)" || key === "人工呼吸器") deviceCand(group, `device-${key}`);
        else for (const d of group) deviceCand([d], `device-${d.kind}`);
      }
      // 在宅酸素療法材料加算 2（T9。R8-215）：酸素の機器が効き、C103 の 2 の指導管理（請求の行か、在宅療養の指示）がある月
      if (devs.some((d) => OXYGEN_KINDS.includes(d.kind))) {
        const code = RULE_CODES.oxygenMaterial2;
        const c103Claim = inClaim(kubunCodes("C103_2")).length > 0;
        if (!c103Claim && !dv.c103) ruleScope.push("在宅酸素療法材料加算は見ていません（C103 の 2 の指導管理の行も在宅療養の指示もない）");
        else if (inClaim([code]).length === 0) {
          if (prevCovered([code]).length > 0) {
            // 前の 2 か月で当月分が算定済み
          } else {
            const notes: Note[] = [
              ...(!c103Claim ? [{ reason: "規則の添え書き" as const, text: "C103 の 2 を算定しない月でも算定できるかは明文がありません（U-44）" }] : []),
              { reason: "規則の添え書き", text: "チアノーゼ型先天性心疾患の患者には算定しません" },
              ...(missingPrev.length > 0 ? [{ reason: "規則の添え書き" as const, text: "前の月に当月分を算定していないか確かめてください" }] : []),
            ];
            const oxy = devs.filter((d) => OXYGEN_KINDS.includes(d.kind));
            ruleCand(ym, [dayUnit([code])], {
              key: "device-C171_2",
              label: nameOf(code),
              basisLabel: "患者の機器",
              requirement: "C103 の 2 の指導管理をした患者に、医療機関が在宅酸素療法装置を提供した月に算定します（R8-215）",
              basis: { basis: "device", sources: [...new Set(oxy.map((d) => sourceOf(d.row)))] },
              dayQuote: oxy.map((d) => d.label).join("・"),
            }, notes);
          }
        }
      }
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
      if (r.tani === 2 || day === 0) return d.some((n) => n > 0); // 日を付けない候補（X-162）は月の中で見る
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
    const bindsFor = (units: AddedUnit[]) => [...(bindsOf(c, checks, claim, units.map((unit) => ({ cand: x.id, unit }))).get(x.id) ?? []), ...units.flatMap((u) => kaisuBinds(c, idx, u, firstDow))];
    let binds = bindsFor(x.units);
    let block = binds.find((b) => b.certain);
    // 処方料（区分を決めない）：もう一方の区分も抑えられるときだけ隠す（16-4-2）
    if (block && x.alt) {
      for (const a of x.alt) {
        const other = bindsFor([a]);
        if (!other.some((b) => b.certain)) {
          binds = other;
          block = undefined;
          break;
        }
      }
    }
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
        // 例外を名指しする（EM §2-12 の HX の一言をそのまま使う。文を作らない）。表の単位で言い分ける：同一月は「月」、1 日は「日」、1 週間は「週」、同時の表は「同時に行うとき」（C-295）
        x.notes.push({ reason: "データの点検の条件つきの違反", text: `${b.partner}${b.exception.unit === "同時" ? "と同時に行うとき" : `を算定する${b.exception.unit}`}は、原則として算定できません。例外：${b.exception.hxText}。当たらなければ、請求にないままで合っています` });
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
                else if (r.kubun === "3" && !eitherSkip(ca, cb)) {
                  // 特例条件ありの「どちらか一方」は 1 件にまとめず、両方の候補に添え書き（C-291）
                  note(a, b, "背反");
                  note(b, a, "背反");
                }
              }
        }
      // 背反区分 3（どちらか一方）が候補どうしで成り立つ組（L-113）。1 つの候補は 1 つの組にだけ入れる（コードの順に決める。並べ方に依らない）。
      // 組に入れなかった関係は、両側の候補に添え書きを付ける（組のほかの関係。C-294・X-155）
      const key = (x: Cand) => `${x.date}|${x.report[0]?.code ?? ""}`;
      for (const [a, b] of either.map(([a, b]) => (key(a) < key(b) ? [a, b] : [b, a])).sort((p, q) => (key(p[0]) + key(p[1]) < key(q[0]) + key(q[1]) ? -1 : 1))) {
        if (pairs.some(([p, q]) => (p.id === a.id && q.id === b.id) || (p.id === b.id && q.id === a.id))) continue;
        if (pairs.some(([p, q]) => [p.id, q.id].includes(a.id) || [p.id, q.id].includes(b.id))) {
          note(a, b, "背反");
          note(b, a, "背反");
          continue;
        }
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
  /** 規則の候補は、同じ規則（key）ごとに 1 件で日の一覧（design.md §16-4-1） */
  const ruleGroups = new Map<string, Cand[]>();
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
    if (x.kind === "rule") {
      const g = ruleGroups.get(x.rule!.key) ?? [];
      g.push(x);
      ruleGroups.set(x.rule!.key, g);
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
          ? `${first.cand.derived!.fromClaim ? "請求" : "カルテ"}${daysPart(dates)}に${first.cand.derived!.what}があり、${first.cand.derived!.name}が請求にありません。${first.cand.derived!.basis}から決まる項目です。算定できるか確かめてください`
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
  for (const list of ruleGroups.values()) {
    const rc = list[0].rule!;
    const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const codes = [...new Set(sorted.flatMap((x) => x.units.flatMap((u) => u.items.map((it) => it.code))))];
    const days = sorted.map((x) => ({ date: x.date, quote: x.rule!.dayQuote, notes: [...x.notes].sort((a, b) => (a.text < b.text ? -1 : 1)), ...(x.rule!.quantity !== undefined ? { quantity: x.rule!.quantity } : {}) }));
    findings.push({
      messageKey: rc.either ? "G11.missing_either" : "G11.missing_rule",
      certainty: "条件つき",
      codes: rc.either ?? codes,
      text: `${rc.basisLabel}${daysPart(sorted.map((x) => x.date))}から、${rc.label}が請求にありません。${rc.requirement}。算定できるか確かめてください`,
      days,
      caution: days.some((d) => d.notes.length > 0),
      source: { data: "chart", ref: "note=" },
      rule: { basis: rc.basis.basis, sources: [...new Set(sorted.flatMap((x) => x.rule!.basis.sources))] },
    });
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
  findings.push(...mismatchFindings);
  // 添え書きのない件を先に、注意つきを後ろに（並べ方は日・コードの順。候補の並べ方に依らない）
  const order = (f: G11Finding) => `${f.caution ? 1 : 0}|${f.days[0]?.date ?? ""}|${f.messageKey}|${f.codes.join(",")}`;
  findings.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));

  // 8. 点検の範囲
  if (unmatched > 0) tally("当てられない行為", unmatched);
  for (const [text, { n, suffix }] of scopeCount) scope.push(`${text}：${n} 件${suffix}`);
  scope.push(...ruleScope);
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
  // 区分誤りの出た対応：R18 の同じ族の区分誤りの添え書きがある候補だけ（回数の区分〔R01 など〕では入れない。C-263）
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
  const unmatchedKey = (u: G11Unmatched) => `${u.date}|${u.written}|${u.noteId ?? ""}|${u.index ?? ""}|${u.child?.index ?? ""}`;
  unmatchedActs.sort((a, b) => (unmatchedKey(a) < unmatchedKey(b) ? -1 : 1));
  return { findings, hidden, unmatchedActs, kubunDoubts, handNotes, guide, ruleGuides, visitTimeDays, materialNotes, scope, counts: { acts: acts.length, unmatched, notSeen: counts.notSeen, hidden: hiddenBy, caution, byKind } };
}
