// 段 19c・19d（design.md §16-4・16-6）：構造化データから規則で出す算定（調剤料・処方料・麻薬等加算・処方箋料・在医総管 注2・患家診療時間加算）。
// FR-207 の表（16-4-8）の T1〜T7 の升ごとにテストを置き、升の id をテストの名前に入れる（最後に FR207_CELLS の全部の id にテストがあることを確かめる）。
// 抑えの表（包括・背反・施設基準）は確かめたい組み合わせだけを作る「作り物の表」で、公開元の表の行ではない。コードは EM の採用値（§2-8 の症例のコード・規則の候補で使うコード、§2-11 の錨）
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ChartAct } from "../../src/chart/acts";
import type { RxOrder, StructuredChart, Visit } from "../../src/connect/types";
import type { DeclarationView } from "../../src/facility/declaration";
import { evaluateG11, type ConfirmedAct, type G11About, type G11Claim, type G11Finding, type G11Result, type G11Structured, type RxDay } from "../../src/generic/g11";
import { resolveRevision } from "../../src/engine/revisions";
import { withStructured } from "../../src/structured/g11-input";
import { FR207_CELLS } from "../../src/structured/fr207-table";
import { isOutsideText, OUTSIDE_WORDS } from "../../src/structured/outside-words";
import type { SItem } from "../../src/structured/overlap";
import { RULE_CODES } from "../../src/structured/rule-codes";
import { dateIn, month, YM } from "../helpers/period";
import { GEN, put } from "./small-masters";
import { C as T, putHaihan, tensuhyoMasters } from "./small-tensuhyo";

const SNAP = "20261001";
const rev = resolveRevision(YM);
const LIVE = { change: "0", created_on: "20100401", abolished_on: "99999999" };
const R = RULE_CODES;
/** 医薬品（EM §2-11 の錨と §2-8 の症例のコード）。剤形と麻薬等の区分は錨の値（A121・A122）と症例の薬の剤形 */
const D = { carve: "622095502", geben: "620008991", halcion: "611120055", xylo: "620007260" } as const;
const KANRI = T.zaiisoukan;
const N2 = rev.codes.C002_N2.primary;
const VISIT = rev.codes.C001_1I.primary;
const OUSHIN = rev.codes.C000.primary;
const SAISHIN = rev.codes.A001.primary;
const SHOHOSEN = rev.codes.F400_3.primary;

/** G11 の点検に要る表と、規則の候補のコードを持つ小さな masters.db */
function rdb(): Database.Database {
  const db = tensuhyoMasters(SNAP);
  db.prepare("INSERT INTO checks_ready (check_id, ready, reason) VALUES ('G03', 1, ''), ('G10', 1, ''), ('G11', 1, '')").run();
  const si = (code: string, name: string, alpha: string, kubun_no: number, more: Record<string, string | number> = {}) => {
    db.prepare("DELETE FROM shinryo WHERE snapshot = ? AND code = ?").run(SNAP, code);
    put(db, "shinryo", SNAP, { code, name, alpha, kubun_no, ...more });
  };
  si(R.chozaiOral, "調剤料（内服薬・浸煎薬・屯服薬）", "F", 0);
  si(R.chozaiExternal, "調剤料（外用薬）", "F", 0);
  si(R.mayakuChozai, "麻薬等加算（調剤料）（入院外）", "F", 0);
  si(R.shohoryo3, "処方料（その他）", "F", 100);
  si(R.shohoryo2, "処方料（７種類以上内服薬）", "F", 100);
  si(R.mayakuShohoryo, "麻薬等加算（処方料）", "F", 100);
  si(R.kakaVisit, "患家診療時間加算（在宅患者訪問診療料（１）・（２））", "C", 1, { unit_code: 1, unit_name: "分" });
  si(R.kakaOushin, "患家診療時間加算（往診料）", "C", 0, { unit_code: 1, unit_name: "分" });
  si(R.kakaOushinSpecial, "患家診療時間加算（特別往診）", "C", 0, { unit_code: 1, unit_name: "分" });
  for (const [code, name, zaikei, mayaku] of [
    [D.carve, "カルベジロール錠１０ｍｇ「ニプロ」", "1", "0"],
    [D.geben, "ゲーベンクリーム１％", "6", "0"],
    [D.halcion, "ハルシオン０．２５ｍｇ錠", "1", "5"],
    [D.xylo, "キシロカイン注ポリアンプ０．５％　５ｍＬ", "4", "0"],
  ])
    put(db, "iyakuhin", SNAP, { code, name, zaikei, mayaku, unit_name: "錠" });
  return db;
}

const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;
const dayArr = (...days: number[]) => Array.from({ length: 31 }, (_, i) => days.filter((d) => d === i + 1).length);
const unit = (codes: string[], ...days: number[]) => ({ items: codes.map((code) => ({ kind: (code.startsWith("6") ? "IY" : "SI") as "SI" | "IY", code })), count: days.length, days: dayArr(...days) });
const sup = <X,>(items: X[]) => ({ status: "supported" as const, items, gaps: {} });
const UNS = { status: "unsupported" as const };
const held: DeclarationView = { held: () => ({ v: "held" }), nameOf: () => null };

/** 処方のオーダー（drugs は [コード, 日数]。日数 null は欠け） */
const order = (ref: string, d: string, place: RxOrder["place"], drugs: [string, number | null][], refills: number | null = null): RxOrder => ({
  ref,
  date: d,
  place,
  refills,
  drugs: drugs.map(([code, days]) => ({ code: { system: "rece", value: code }, name: `薬 ${code}`, days, quantity: null })),
});
/** オーダーの薬の当てたコードつきの行為（当て方は 19b の規則。ここでは rece をそのまま当てた形）。コードが null の薬は判定の外 */
const itemsOf = (orders: RxOrder[], unmapped: string[] = []): SItem[] =>
  orders.flatMap((o) =>
    o.drugs.map((d, i): SItem => {
      const code = d.code!.value;
      const out = unmapped.includes(code);
      return { part: "orders", kind: "drug", ref: `${o.ref}/${i}`, date: o.date, code: out ? null : code, tbl: out ? null : "iyakuhin", name: d.name!, ...(out ? { out: "対応表にないコード" as const } : {}) };
    }),
  );
const visit = (ref: string, d: number, kind: Visit["kind"], start: string | null, end: string | null): Visit => ({ ref, date: date(d), kind, start, end });

type Opt = {
  orders?: RxOrder[] | "unsupported";
  visits?: Visit[] | "unsupported";
  /** さかのぼる月（新しい月から）。省くと 12 か月とも 0 件の受け取り */
  history?: G11Structured["history"];
  texts?: G11Structured["texts"];
  acts?: ConfirmedAct[];
  rxDays?: RxDay[];
  dispensing?: G11About["dispensing"];
  declaration?: DeclarationView;
  unmapped?: string[];
  /** 構造化データを渡さない（v32 の入力） */
  noStructured?: boolean;
};
const emptyHistory = (): G11Structured["history"] => Array.from({ length: 12 }, (_, i) => ({ yearMonth: month(-(i + 1)), orders: sup<RxOrder>([]), items: [] }));
function about(o: Opt = {}): G11About {
  const orders = o.orders === "unsupported" ? null : (o.orders ?? []);
  const chart: StructuredChart = {
    visits: o.visits === "unsupported" || o.visits === undefined ? UNS : sup(o.visits),
    orders: orders === null ? UNS : sup(orders),
    procedures: UNS,
    homeCare: UNS,
  };
  const items = orders ? itemsOf(orders, o.unmapped) : [];
  const S: G11Structured = { chart, items, history: o.history ?? emptyHistory(), lookbackMonths: 12, texts: o.texts ?? [] };
  const acts = o.noStructured ? (o.acts ?? []) : withStructured(o.acts ?? [], { chart, items }, rev).acts;
  return {
    yearMonth: YM,
    generation: GEN,
    acts,
    rxDays: o.rxDays ?? [],
    path: "uke",
    dispensing: o.dispensing ?? "inside",
    declaration: o.declaration ?? held,
    outpatient: true,
    ...(o.noStructured ? {} : { structured: S }),
  };
}
const ok = (r: G11Result) => {
  if ("skip" in r) throw new Error(r.skip);
  return r;
};
const run = (db: Database.Database, claim: G11Claim, o: Opt = {}) => ok(evaluateG11(claim, db, about(o), rev));
const rules = (r: ReturnType<typeof run>) => r.findings.filter((f) => f.messageKey === "G11.missing_rule");
const ruleKeys = (r: ReturnType<typeof run>) => rules(r).map((f) => `${f.codes.join("+")} ${f.days.map((d) => Number(d.date.slice(8))).join(",")}${f.caution ? " 注意つき" : ""}`);
const notesOf = (f: G11Finding) => f.days.flatMap((d) => d.notes.map((n) => n.text));
const n2Scope = (r: ReturnType<typeof run>) => r.scope.filter((s) => s.startsWith("処方箋を交付しない場合の加算"));
/** 文章の行為（確かめたカルテ） */
let nid = 0;
const textAct = (d: number, code: string, written: string, category: ChartAct["category"], tbl: "shinryo" | "iyakuhin" = "shinryo"): ConfirmedAct => ({
  date: date(d),
  noteId: ++nid,
  act: { category, written, lookup: [], quote: written, match: { tbl, code, name: written, by: "name" } },
});
const text = (d: number | string, body: string, confirmed = true) => ({ date: typeof d === "number" ? date(d) : d, text: body, confirmed });

/** 升の id を名前に入れたテスト。表の全部の升にテストがあるかを最後に確かめる */
const covered = new Set<string>();
const cell = (ids: string | string[], name: string, fn: () => void) => {
  const list = Array.isArray(ids) ? ids : [ids];
  for (const id of list) covered.add(id);
  it(`${list.join("・")}：${name}`, fn);
};
/** 作り物の包括の親（手術後医学管理料。EM §2-11 の錨 A40。補助マスターのグループ B001051・1 日）にコードを包括させる */
const bundleUnderJutsugo = (db: Database.Database, ...codes: string[]) => {
  for (const code of codes) put(db, "houkatsu", SNAP, { ...LIVE, group_no: "B001051", code, tokurei: "0" });
};
/** 在医総管の包括（補助マスターのグループ C002001。A34・A35 と同じ形）に投薬の行を足す */
const bundleUnderKanri = (db: Database.Database) => {
  for (const code of [R.chozaiOral, R.chozaiExternal, R.shohoryo3, R.shohoryo2, R.mayakuChozai, R.mayakuShohoryo]) put(db, "houkatsu", SNAP, { ...LIVE, group_no: "C002001", code, tokurei: "0" });
};
const inside14 = (drugs: [string, number | null][]) => [order("o1", date(14), "院内", drugs)];

// ───────────────────────────────────────────────────────────────────────────
// T1・T2：調剤料（内服・外用）

for (const [row, drug, code, label] of [
  ["T1", D.carve, R.chozaiOral, "調剤料（内服薬・浸煎薬・屯服薬）"],
  ["T2", D.geben, R.chozaiExternal, "調剤料（外用薬）"],
] as const) {
  describe(`${row} ${label}（R8-228・R8-229・R8-237）`, () => {
    cell(`${row}-出る`, "オーダーの院内の日に剤形の薬があり、請求にその日のコードがなければ、カルテに書かれていなくても指摘に出る（§15-8 の挙動が変わるところ。C-403）。請求にあれば出ない", () => {
      const db = rdb();
      const r = run(db, { units: [] }, { orders: inside14([[drug, 14]]), texts: [text(14, "定期処方")] });
      const f = rules(r).find((x) => x.codes.includes(code))!;
      expect(f.text).toBe(`オーダー（14日）から、${label}が請求にありません。院内で投薬した 1 回の処方につき 1 回算定します（R8-237）。算定できるか確かめてください`);
      expect(f.rule).toEqual({ basis: "order", sources: ["電子カルテ"] });
      expect(f.certainty).toBe("条件つき");
      expect(f.text).not.toMatch(/点|円/);
      const have = run(db, { units: [unit([code], 14)] }, { orders: inside14([[drug, 14]]) });
      expect(rules(have).some((x) => x.codes.includes(code))).toBe(false);
    });
    cell(`${row}-包括で出ない`, "元の請求の行と G04 の言い切りの包括が結び付くと隠れ、言わなかったものに包括の理由で並ぶ（作った包括の行）", () => {
      const db = rdb();
      bundleUnderJutsugo(db, code);
      const r = run(db, { units: [unit([T.jutsugo], 14)] }, { orders: inside14([[drug, 14]]) });
      expect(rules(r).some((x) => x.codes.includes(code))).toBe(false);
      expect(r.hidden).toContainEqual(expect.objectContaining({ written: label, date: date(14), reason: "包括", check: "G04" }));
    });
    cell(`${row}-背反で出ない`, "同じ日に院内と院外のオーダーがある日は出さず、処方箋料に R8-239 の添え書き。元の請求の行と G05 の言い切りの背反でも隠れる", () => {
      const db = rdb();
      const mixed = run(db, { units: [] }, { orders: [order("o1", date(14), "院内", [[drug, 14]]), order("o2", date(14), "院外", [[D.carve, 14]])] });
      expect(rules(mixed).some((x) => x.codes.includes(code))).toBe(false);
      const rx = rules(mixed).find((x) => x.codes.includes(SHOHOSEN))!;
      expect(notesOf(rx)).toContain("同じ日に院内と院外のオーダーがあります。原則認められず、緊急やむを得ない場合は調剤料・処方料を算定せず、摘要欄に日付と理由を書きます（R8-239）");
      putHaihan(db, SNAP, 1, T.sansoKyunyu, code, "1", "0");
      const r = run(db, { units: [unit([T.sansoKyunyu], 14)] }, { orders: inside14([[drug, 14]]) });
      expect(rules(r).some((x) => x.codes.includes(code))).toBe(false);
      expect(r.hidden).toContainEqual(expect.objectContaining({ written: label, reason: "背反", check: "G05" }));
    });
    cell(`${row}-在医総管の月で出ない`, "在医総管の月は、G04 の A35 と同じ形の包括で隠れる（R8-241 (a)）", () => {
      const db = rdb();
      bundleUnderKanri(db);
      const r = run(db, { units: [unit([KANRI], 28)] }, { orders: inside14([[drug, 14]]) });
      expect(rules(r).some((x) => x.codes.includes(code))).toBe(false);
      expect(r.hidden).toContainEqual(expect.objectContaining({ written: label, reason: "包括", check: "G04", partner: expect.stringContaining("在医総管") }));
    });
    cell(`${row}-項目が取れず見ない`, "オーダーを受け取らず院内に決まらない日・オーダーの院内院外の欠け・薬のコードが判定の外は、出さずに「見ていません」と数", () => {
      const db = rdb();
      const noOrder = run(db, { units: [] }, { orders: "unsupported", acts: [textAct(14, drug, "薬", "投薬", "iyakuhin")], rxDays: [{ date: date(14), rx: true, choice: "unknown" }] });
      expect(rules(noOrder)).toEqual([]);
      expect(noOrder.guide).toBe("14日の処方の院内・院外を選ぶと、薬の取り忘れを見ます");
      const blank = run(db, { units: [] }, { orders: [order("o1", date(14), null, [[drug, 14]])] });
      expect(rules(blank)).toEqual([]);
      expect(blank.scope).toContain("オーダーの院内・院外が欠けているので、調剤料・処方料は見ていません：1 件");
      const out = run(db, { units: [] }, { orders: inside14([[drug, 14]]), unmapped: [drug] });
      expect(rules(out)).toEqual([]);
      expect(out.scope).toContain("調剤料・処方料は、オーダーの薬のコードが判定の外で剤形を読めない分を見ていません：1 件");
    });
    cell(`${row}-そのほか出ない`, "剤形が内服・外用の薬がない日（自己注射の薬だけ。GK-R8-02-Q65）は出ない", () => {
      const db = rdb();
      const r = run(db, { units: [] }, { orders: inside14([[D.xylo, 1]]) });
      expect(rules(r)).toEqual([]);
    });
  });
}

describe("投薬の組の、オーダーの院内の日（16-4-1・16-4-2）", () => {
  it("施設の申告が「院外処方だけ」でオーダーが院内の日に、調剤料・処方料が添え書き「施設の申告は院外処方だけ。オーダーは院内」つきで出る", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: inside14([[D.carve, 14]]), dispensing: "outside" });
    expect(ruleKeys(r)).toEqual([`${R.chozaiOral} 14 注意つき`, `${R.shohoryo3} 14 注意つき`]);
    for (const f of rules(r)) expect(notesOf(f)).toContain("施設の申告は院外処方だけ。オーダーは院内");
  });
  it("本人が確かめた選択とオーダーが違う日は、オーダーで決めて食い違いを添える", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: inside14([[D.carve, 14]]), rxDays: [{ date: date(14), rx: true, choice: "outside", confirmed: true }] });
    expect(notesOf(rules(r)[0])).toContain("本人の選択は院外処方箋。オーダーは院内");
  });
  it("同じ日に 2 つの院内のオーダー（U-50）は 1 件の候補にし、「別々の処方なら回数が増えます」を添える（L-200）", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: [order("o1", date(14), "院内", [[D.carve, 14]]), order("o2", date(14), "院内", [[D.geben, 14]])] });
    expect(ruleKeys(r)).toEqual([`${R.chozaiOral} 14 注意つき`, `${R.chozaiExternal} 14 注意つき`, `${R.shohoryo3} 14 注意つき`]);
    expect(notesOf(rules(r)[0])).toContain("同じ日にオーダーが 2 件あります。別々の処方なら回数が増えます（明文なし。EM U-50）");
  });
  it("内服と外用の両方がある日は、調剤料のイとロの両方（R8-237）。日をまたいだ同じ規則は 1 件で日の一覧", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: [order("o1", date(7), "院内", [[D.carve, 14], [D.geben, 7]]), order("o2", date(21), "院内", [[D.carve, 14]])] });
    expect(ruleKeys(r)).toEqual([`${R.chozaiOral} 7,21`, `${R.chozaiExternal} 7`, `${R.shohoryo3} 7,21`]);
  });
  it("文章の調剤料の行為は、規則が見る日は規則の側にたたむ（同じ日・同じコードの指摘が 1 件）", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: inside14([[D.carve, 14]]), acts: [textAct(14, R.chozaiOral, "調剤料", "投薬")] });
    expect(r.findings.filter((f) => f.codes.includes(R.chozaiOral)).map((f) => f.messageKey)).toEqual(["G11.missing_rule"]);
    expect(r.scope).toContain("規則で見る行為をたたみました：1 件");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T3：処方料（区分を決めない）

describe("T3 処方料（区分を決めない。R8-231・R8-232・R8-240。L-173）", () => {
  cell("T3-出る", "院内の日に剤形 1・6 の薬が 1 つ以上で、請求にその日の F100 のどの区分もなければ、区分を書かない 1 件（向精神薬の薬がある日も同じ 1 件）", () => {
    const db = rdb();
    for (const drug of [D.carve, D.halcion]) {
      const r = run(db, { units: [] }, { orders: inside14([[drug, 14]]) });
      const f = rules(r).filter((x) => x.codes.includes(R.shohoryo3) || x.codes.includes(R.shohoryo2));
      expect(f.map((x) => x.codes)).toEqual([[R.shohoryo3]]);
      expect(f[0].text).toBe("オーダー（14日）から、処方料が請求にありません。1 回の処方につき 1 回算定します。区分は内服の種類・向精神薬の長期処方と多剤投与で決まります（R8-240）。算定できるか確かめてください");
    }
  });
  cell("T3-包括で出ない", "手順 1 は 2 つの区分のコードの両方が隠れるときだけ隠す（片方だけの包括では出る）", () => {
    const db = rdb();
    bundleUnderJutsugo(db, R.shohoryo3);
    const one = run(db, { units: [unit([T.jutsugo], 14)] }, { orders: inside14([[D.carve, 14]]) });
    expect(rules(one).some((x) => x.codes.includes(R.shohoryo3))).toBe(true);
    bundleUnderJutsugo(db, R.shohoryo2);
    const both = run(db, { units: [unit([T.jutsugo], 14)] }, { orders: inside14([[D.carve, 14]]) });
    expect(rules(both).some((x) => x.codes.includes(R.shohoryo3))).toBe(false);
    expect(both.hidden).toContainEqual(expect.objectContaining({ written: "処方料", reason: "包括" }));
  });
  cell("T3-背反で出ない", "同じ日に院内と院外のオーダーでは出ない。G05 の言い切りの背反が 2 つの区分の両方に結び付くと隠れる", () => {
    const db = rdb();
    const mixed = run(db, { units: [] }, { orders: [order("o1", date(14), "院内", [[D.carve, 14]]), order("o2", date(14), "院外", [[D.carve, 14]])] });
    expect(rules(mixed).some((x) => x.codes.includes(R.shohoryo3))).toBe(false);
    putHaihan(db, SNAP, 1, T.sansoKyunyu, R.shohoryo3, "1", "0");
    putHaihan(db, SNAP, 1, T.sansoKyunyu, R.shohoryo2, "1", "0");
    const r = run(db, { units: [unit([T.sansoKyunyu], 14)] }, { orders: inside14([[D.carve, 14]]) });
    expect(rules(r).some((x) => x.codes.includes(R.shohoryo3))).toBe(false);
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "処方料", reason: "背反" }));
  });
  cell("T3-在医総管の月で出ない", "在医総管の月は包括で隠れる", () => {
    const db = rdb();
    bundleUnderKanri(db);
    const r = run(db, { units: [unit([KANRI], 28)] }, { orders: inside14([[D.carve, 14]]) });
    expect(rules(r).some((x) => x.codes.includes(R.shohoryo3))).toBe(false);
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "処方料", reason: "包括" }));
  });
  cell("T3-項目が取れず見ない", "T1 と同じ：オーダーの院内院外の欠け・薬のコードが判定の外は「見ていません」", () => {
    const db = rdb();
    expect(rules(run(db, { units: [] }, { orders: [order("o1", date(14), null, [[D.carve, 14]])] }))).toEqual([]);
    expect(run(db, { units: [] }, { orders: inside14([[D.carve, 14]]), unmapped: [D.carve] }).scope).toContain("調剤料・処方料は、オーダーの薬のコードが判定の外で剤形を読めない分を見ていません：1 件");
  });
  cell("T3-そのほか出ない", "請求にその日の F100 のどれかの区分がある（区分が違っても出さない。C-402）", () => {
    const db = rdb();
    for (const code of [R.shohoryo2, R.shohoryo3]) {
      const r = run(db, { units: [unit([code], 14)] }, { orders: inside14([[D.carve, 14]]) });
      expect(rules(r).some((x) => x.codes.includes(R.shohoryo3) || x.codes.includes(R.shohoryo2))).toBe(false);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T4：麻薬等加算

describe("T4 麻薬等加算（R8-230・R8-233・R8-238。L-174）", () => {
  const both = [R.mayakuChozai, R.mayakuShohoryo];
  cell("T4-出る", "院内の日に、医薬品マスターの区分が麻薬等（向精神薬 5）の薬があれば、調剤料の側と処方料の側の 1 件", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: inside14([[D.halcion, 14]]) });
    expect(rules(r).find((x) => x.codes.includes(R.mayakuChozai))!.codes).toEqual(both);
    expect(rules(run(db, { units: [] }, { orders: inside14([[D.carve, 14]]) })).some((x) => x.codes.includes(R.mayakuChozai))).toBe(false);
  });
  cell("T4-包括で出ない", "G04 の言い切りの包括で隠れる", () => {
    const db = rdb();
    bundleUnderJutsugo(db, ...both);
    const r = run(db, { units: [unit([T.jutsugo], 14)] }, { orders: inside14([[D.halcion, 14]]) });
    expect(rules(r).some((x) => x.codes.includes(R.mayakuChozai))).toBe(false);
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "麻薬等加算（調剤料・処方料）", reason: "包括" }));
  });
  cell("T4-背反で出ない", "同じ日に院内と院外のオーダーでは出ない。G05 の言い切りの背反で隠れる", () => {
    const db = rdb();
    const mixed = run(db, { units: [] }, { orders: [order("o1", date(14), "院内", [[D.halcion, 14]]), order("o2", date(14), "院外", [[D.carve, 14]])] });
    expect(rules(mixed).some((x) => x.codes.includes(R.mayakuChozai))).toBe(false);
    putHaihan(db, SNAP, 1, T.sansoKyunyu, R.mayakuChozai, "1", "0");
    const r = run(db, { units: [unit([T.sansoKyunyu], 14)] }, { orders: inside14([[D.halcion, 14]]) });
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "麻薬等加算（調剤料・処方料）", reason: "背反" }));
  });
  cell("T4-在医総管の月で出ない", "在医総管の月は包括で隠れる", () => {
    const db = rdb();
    bundleUnderKanri(db);
    const r = run(db, { units: [unit([KANRI], 28)] }, { orders: inside14([[D.halcion, 14]]) });
    expect(rules(r)).toEqual([]);
    expect(r.hidden.map((h) => h.written).sort()).toEqual(["処方料", "薬 611120055", "調剤料（内服薬・浸煎薬・屯服薬）", "麻薬等加算（調剤料・処方料）"]);
  });
  cell("T4-項目が取れず見ない", "麻薬等の区分の列（E-12 の錨）を読めないマスターでは、全部「見ていません」", () => {
    const db = rdb();
    db.exec("ALTER TABLE iyakuhin DROP COLUMN mayaku");
    const r = run(db, { units: [] }, { orders: inside14([[D.halcion, 14]]) });
    expect(rules(r).some((x) => x.codes.includes(R.mayakuChozai))).toBe(false);
    expect(r.scope).toContain("麻薬等の区分を医薬品マスターから読めないので、麻薬等加算は見ていません：1 件");
  });
  cell("T4-そのほか出ない", "院外の日は出さない（処方箋料に麻薬等加算の規定がない）", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: [order("o1", date(14), "院外", [[D.halcion, 14]])] });
    expect(rules(r).some((x) => x.codes.includes(R.mayakuChozai))).toBe(false);
    expect(ruleKeys(r)).toEqual([`${SHOHOSEN} 14`]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T5：処方箋料

describe("T5 処方箋料（F400_3。区分は R07。R8-25・R8-26・#7-13）", () => {
  const outside = [order("o1", date(14), "院外", [[D.carve, 14]])];
  cell("T5-出る", "院外のオーダーの日に、請求にどの処方箋料の区分もなければ出る（院内処方もある施設でも、本人の選択でなくオーダーで決める）", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: outside, rxDays: [{ date: date(14), rx: true, choice: "unknown" }] });
    expect(ruleKeys(r)).toEqual([`${SHOHOSEN} 14`]);
    expect(rules(r)[0].text).toBe("オーダー（14日）から、処方箋料が請求にありません。院外処方箋を交付した日に算定します（R8-236）。算定できるか確かめてください");
    expect(r.guide).toBeNull();
  });
  cell("T5-包括で出ない", "元の請求の行と G04 の言い切りの包括で隠れる", () => {
    const db = rdb();
    bundleUnderJutsugo(db, SHOHOSEN);
    const r = run(db, { units: [unit([T.jutsugo], 14)] }, { orders: outside });
    expect(rules(r)).toEqual([]);
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "処方箋料", reason: "包括" }));
  });
  cell("T5-背反で出ない", "元の請求の行と G05 の言い切りの背反で隠れる", () => {
    const db = rdb();
    putHaihan(db, SNAP, 1, T.sansoKyunyu, SHOHOSEN, "1", "0");
    const r = run(db, { units: [unit([T.sansoKyunyu], 14)] }, { orders: outside });
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "処方箋料", reason: "背反" }));
  });
  cell("T5-在医総管の月で出ない", "在医総管の月は、手順 1 の G04（A35）で隠れる（#7-6）", () => {
    const db = rdb();
    const r = run(db, { units: [unit([KANRI], 28)] }, { orders: outside, texts: [text(14, "院外処方")] });
    expect(rules(r)).toEqual([]);
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "処方箋料", reason: "包括", check: "G04" }));
  });
  cell("T5-項目が取れず見ない", "オーダーを受け取らず、本人の選択・申告でも院外に決まらない日は出さず、院内・院外を選ぶ案内", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: "unsupported", acts: [textAct(14, D.carve, "薬", "投薬", "iyakuhin")], rxDays: [{ date: date(14), rx: true, choice: "unknown" }] });
    expect(rules(r)).toEqual([]);
    expect(r.findings.some((f) => f.codes.includes(SHOHOSEN))).toBe(false);
    expect(r.guide).toBe("14日の処方の院内・院外を選ぶと、薬の取り忘れを見ます");
  });
  cell("T5-そのほか出ない", "確かめた行為に処方箋料がその日にあれば、規則の候補にせず 1 つにまとめる（X-147）", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: outside, acts: [textAct(14, SHOHOSEN, "処方箋料", "投薬")] });
    expect(r.findings.filter((f) => f.codes.includes(SHOHOSEN)).map((f) => f.messageKey)).toEqual(["G11.missing"]);
  });
  it("施設基準（G10）で算定できないと決まるものも出ない（手順 1 のまま）", () => {
    const db = rdb();
    db.prepare("UPDATE shinryo SET shisetsu_g1 = '721' WHERE snapshot = ? AND code = ?").run(SNAP, SHOHOSEN);
    const decl: DeclarationView = { held: (k) => (k === "721" ? { v: "not", reason: "notified_no" } : { v: "held" }), nameOf: () => null };
    const r = run(db, { units: [] }, { orders: outside, declaration: decl });
    expect(rules(r)).toEqual([]);
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "処方箋料", reason: "施設基準" }));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T6：在医総管 注2

describe("T6 在医総管 注2（版の C002_N2。R8-18・R8-241）", () => {
  const kanri = { units: [unit([KANRI], 14)] };
  const base = (o: Opt = {}): Opt => ({ orders: inside14([[D.carve, 14]]), texts: [text(14, "定期処方を院内で投薬")], ...o });
  const hasN2 = (r: ReturnType<typeof run>) => rules(r).some((f) => f.codes.includes(N2));

  cell("T6-出る", "在医総管の月で、院外のオーダー 0 件・院内のオーダー 1 件以上・30 日を超える院外処方がかからない・文章が院外を示す日がない・訪問の日の全部にカルテの文章がある・請求に処方箋料がない", () => {
    const db = rdb();
    const r = run(db, kanri, base());
    const f = rules(r).find((x) => x.codes.includes(N2))!;
    expect(f.text).toBe(
      "オーダー（14日）から、処方箋を交付しない場合の加算が請求にありません。在医総管の月で、院外処方箋を交付していない月に算定します（R8-241）。当月にかかる 30 日を超える院外処方は、前の 12 か月のオーダーで確かめました。算定できるか確かめてください",
    );
    expect(n2Scope(r)).toEqual([]);
  });
  cell("T6-包括で出ない", "該当しない（注2 は管理料の加算）：在医総管の月に出ることを確かめる", () => {
    const db = rdb();
    bundleUnderKanri(db);
    expect(hasN2(run(db, kanri, base()))).toBe(true);
  });
  cell("T6-背反で出ない-1", "院外のオーダーがその月に 1 件でもあれば出さない（R8-241 (c)）。「見ていません」にもしない", () => {
    const db = rdb();
    const r = run(db, kanri, base({ orders: [...inside14([[D.carve, 14]]), order("o2", date(21), "院外", [[D.carve, 7]])] }));
    expect(hasN2(r)).toBe(false);
    expect(n2Scope(r)).toEqual([]);
  });
  cell("T6-背反で出ない-2", "(i) X-231 の核：当月の 4 か月前の 25 日の院外のオーダー 120 日分が当月にかかり、注2 が出ない（3 か月だけ読むと出てしまう）", () => {
    const db = rdb();
    const history = emptyHistory();
    history[3] = { yearMonth: month(-4), orders: sup([order("p1", dateIn(-4, 25), "院外", [[D.carve, 120]])]), items: [] };
    expect(hasN2(run(db, kanri, base({ history })))).toBe(false);
    expect(hasN2(run(db, kanri, base({ history: history.slice(0, 3) })))).toBe(true);
  });
  cell("T6-背反で出ない-3", "(ii) 前の月の 14 日分（30 日以下）の院外のオーダーは (d) に掛からず、注2 が出る", () => {
    const db = rdb();
    const history = emptyHistory();
    history[0] = { yearMonth: month(-1), orders: sup([order("p1", dateIn(-1, 25), "院外", [[D.carve, 14]], 0)]), items: [] };
    expect(hasN2(run(db, kanri, base({ history, texts: [text(14, "定期処方を院内で投薬")] })))).toBe(true);
  });
  cell("T6-背反で出ない-4", "(ix) 院内のオーダーだけで請求に処方箋料がある月は出さず、食い違いの「見ていません」（X-251）", () => {
    const db = rdb();
    const r = run(db, { units: [unit([KANRI], 14), unit([SHOHOSEN], 14)] }, base());
    expect(hasN2(r)).toBe(false);
    expect(n2Scope(r)).toEqual(["処方箋を交付しない場合の加算は見ていません（請求に処方箋料があり、院外のオーダーと食い違います：1 日）"]);
  });
  cell("T6-在医総管の月で出ない", "逆：在医総管のない月は出ない（加算の元がない）。「見ていません」も出さない", () => {
    const db = rdb();
    const r = run(db, { units: [] }, base());
    expect(hasN2(r)).toBe(false);
    expect(n2Scope(r)).toEqual([]);
  });
  cell("T6-項目が取れず見ない-1", "処方のオーダーを受け取っていない月", () => {
    const db = rdb();
    expect(n2Scope(run(db, kanri, base({ orders: "unsupported" })))).toContain("処方箋を交付しない場合の加算は見ていません（処方のオーダーを受け取っていない）");
  });
  cell("T6-項目が取れず見ない-2", "投薬のない月（U-52。照会 #19）", () => {
    const db = rdb();
    expect(n2Scope(run(db, kanri, base({ orders: [] })))).toEqual(["処方箋を交付しない場合の加算は見ていません（投薬のない月（照会中））"]);
  });
  cell("T6-項目が取れず見ない-3", "(iii) 範囲の中の月の院外のオーダーの内服の days が欠ける・範囲の中の月を読めない（残していない）と「見ていません」（X-231）", () => {
    const db = rdb();
    const gap = emptyHistory();
    gap[1] = { yearMonth: month(-2), orders: sup([order("p1", dateIn(-2, 3), "院外", [[D.carve, null]])]), items: itemsOf([order("p1", dateIn(-2, 3), "院外", [[D.carve, null]])]) };
    expect(n2Scope(run(db, kanri, base({ history: gap })))).toEqual(["処方箋を交付しない場合の加算は見ていません（前の処方を読めない）"]);
    const missing = emptyHistory();
    missing[11] = { yearMonth: month(-12), orders: null, items: [] };
    expect(n2Scope(run(db, kanri, base({ history: missing })))).toEqual(["処方箋を交付しない場合の加算は見ていません（前の処方を読めない）"]);
  });
  cell("T6-項目が取れず見ない-4", "(iv) オーダーのない処方の日で、初期値「院内」のまま印がない日があると「見ていません」と案内。同じ日に本人が印を付けると出る（文字の初期値だけでは出ない。C-410）", () => {
    const db = rdb();
    const o = base({ texts: [text(14, "定期処方を院内で投薬"), text(21, "院内で湿布")], acts: [textAct(21, D.geben, "湿布", "投薬", "iyakuhin")] });
    const r = run(db, kanri, { ...o, rxDays: [{ date: date(21), rx: true, choice: "inside" }] });
    expect(hasN2(r)).toBe(false);
    expect(n2Scope(r)).toEqual(["処方箋を交付しない場合の加算は見ていません（院内・院外が確かめられていない日：1 日）"]);
    expect(r.ruleGuides).toContain("21日の処方の院内・院外を確かめると、処方箋を交付しない場合の加算を見ます");
    const marked = run(db, kanri, { ...o, rxDays: [{ date: date(21), rx: true, choice: "inside", confirmed: true }] });
    expect(hasN2(marked)).toBe(true);
  });
  cell("T6-項目が取れず見ない-5", "(v) 当月に院内のオーダーがある日で、確かめた文章が「院外処方箋」を言うと「見ていません」と食い違いの添え書き（C-412）", () => {
    const db = rdb();
    const r = run(db, kanri, base({ texts: [text(14, "院外処方箋を発行")] }));
    expect(hasN2(r)).toBe(false);
    expect(n2Scope(r)).toEqual(["処方箋を交付しない場合の加算は見ていません（文章に院外処方箋の記載：1 日）"]);
    expect(r.scope).toContain("文章に院外処方箋の記載があり、オーダーは院内の日（食い違い）：14日");
  });
  cell("T6-項目が取れず見ない-6", "(vi) 範囲の中の前の月に、オーダーのない日の文章に院外処方の記載があると「見ていません」（期間の分からない院外処方。X-241）", () => {
    const db = rdb();
    const r = run(db, kanri, base({ texts: [text(14, "定期処方を院内で投薬"), text(dateIn(-1, 10), "院外処方とした", false)] }));
    expect(n2Scope(r)).toEqual(["処方箋を交付しない場合の加算は見ていません（期間の分からない院外処方：1 日）"]);
  });
  cell("T6-項目が取れず見ない-7", "(vii) 4 日の訪問のうち 2 日だけカルテを貼り、オーダーは院内だけ → 「カルテの文章のない訪問の日：2 日」。貼っていない日の文章に院外処方の語があれば、貼ったあとはその日で抑える（C-420）", () => {
    const db = rdb();
    const visits = [3, 10, 17, 24].map((d) => visit(`v${d}`, d, "訪問診療", null, null));
    const r = run(db, kanri, base({ visits, texts: [text(3, "定期処方を院内で投薬", false), text(10, "経過良好")] }));
    expect(hasN2(r)).toBe(false);
    expect(n2Scope(r)).toEqual(["処方箋を交付しない場合の加算は見ていません（カルテの文章のない訪問の日：2 日）"]);
    const pasted = run(db, kanri, base({ visits, texts: [text(3, "定期処方を院内で投薬", false), text(10, "経過良好"), text(17, "経過良好"), text(24, "院外処方箋を発行", false)] }));
    expect(n2Scope(pasted)).toEqual(["処方箋を交付しない場合の加算は見ていません（文章に院外処方箋の記載：1 日）"]);
  });
  cell("T6-項目が取れず見ない-8", "(viii) 「定期薬は院外処方箋発行、湿布は院内で投薬」の日（三択の初期値では「分からない」）で注2 が出ない（院外の語が院内の語と混ざっていても院外。X-250）", () => {
    const db = rdb();
    const r = run(db, kanri, base({ texts: [text(14, "定期薬は院外処方箋発行、湿布は院内で投薬")] }));
    expect(hasN2(r)).toBe(false);
    expect(n2Scope(r)).toEqual(["処方箋を交付しない場合の加算は見ていません（文章に院外処方箋の記載：1 日）"]);
  });
  cell("T6-項目が取れず見ない-9", "(xi) 施設の申告が院外処方だけでオーダーのない処方の日があると「見ていません」と理由の行", () => {
    const db = rdb();
    const r = run(db, kanri, base({ dispensing: "outside", texts: [text(14, "定期処方を院内で投薬"), text(21, "湿布")], rxDays: [{ date: date(21), rx: true, choice: null }] }));
    expect(n2Scope(r)).toEqual(["処方箋を交付しない場合の加算は見ていません（施設の申告は院外処方だけ：オーダーのない処方の日 1 日）"]);
  });
  cell("T6-項目が取れず見ない-10", "日数のない院外処方（外用）・リフィルの院外処方（回数 2 以上）が範囲の中にあると「見ていません」（C-423。L-201 の既定）", () => {
    const db = rdb();
    const noDays = emptyHistory();
    const o = order("p1", dateIn(-3, 8), "院外", [[D.geben, null]]);
    noDays[2] = { yearMonth: month(-3), orders: sup([o]), items: itemsOf([o]) };
    expect(n2Scope(run(db, kanri, base({ history: noDays })))).toEqual(["処方箋を交付しない場合の加算は見ていません（日数のない・リフィルの院外処方：1 件）"]);
    const refill = emptyHistory();
    refill[0] = { yearMonth: month(-1), orders: sup([order("p2", dateIn(-1, 8), "院外", [[D.carve, 28]], 2)]), items: [] };
    expect(n2Scope(run(db, kanri, base({ history: refill })))).toEqual(["処方箋を交付しない場合の加算は見ていません（日数のない・リフィルの院外処方：1 件）"]);
  });
  cell("T6-そのほか出ない", "請求に注2 があれば出さない", () => {
    const db = rdb();
    const r = run(db, { units: [unit([KANRI, N2], 14)] }, base());
    expect(hasN2(r)).toBe(false);
    expect(n2Scope(r)).toEqual([]);
  });
  it("院外の語の規則は決まった語の一覧で、三択の初期値の院外の語と同じ一覧から始まる", () => {
    expect(OUTSIDE_WORDS).toEqual(["院外処方", "処方箋", "処方せん"]);
    expect(isOutsideText("定期薬は院外処方箋発行、湿布は院内で投薬")).toBe(true);
    expect(isOutsideText("定期薬を院内で投薬")).toBe(false);
    expect(isOutsideText("Ｄｏ　処方 せ ん")).toBe(true);
  });
});

describe("構造化データのない請求（v32 の入力）", () => {
  it("規則の候補を出さず、注2・時間の加算の「見ていません」も出さない（v32 の点検の範囲のまま）", () => {
    const db = rdb();
    const r = ok(evaluateG11({ units: [unit([KANRI, VISIT], 14)] }, db, about({ noStructured: true, acts: [textAct(14, T.sansoKyunyu, "酸素吸入", "処置")] }), rev));
    expect(rules(r)).toEqual([]);
    expect(r.scope.filter((s) => s.includes("処方箋を交付しない") || s.includes("時間の加算"))).toEqual([]);
  });
});

describe("FR-207 の表の升（16-4-8）", () => {
  it("FR207_CELLS の T1〜T6 の全部の升の id に、テストが 1 件以上ある（升を空にしない。L-197・C-413）", () => {
    expect(FR207_CELLS.length).toBe(6 * 6 + 3 + 9);
    expect(FR207_CELLS.filter((id) => !covered.has(id))).toEqual([]);
  });
});
