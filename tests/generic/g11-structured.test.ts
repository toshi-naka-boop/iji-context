// 段 19c・19d（design.md §16-4・16-6）：構造化データから規則で出す算定（調剤料・処方料・麻薬等加算・処方箋料・在医総管 注2・患家診療時間加算）。
// FR-207 の表（16-4-8）の T1〜T7 の升ごとにテストを置き、升の id をテストの名前に入れる（最後に FR207_CELLS の全部の id にテストがあることを確かめる）。
// 抑えの表（包括・背反・施設基準）は確かめたい組み合わせだけを作る「作り物の表」で、公開元の表の行ではない。コードは EM の採用値（§2-8 の症例のコード・規則の候補で使うコード、§2-11 の錨）
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ChartAct } from "../../src/chart/acts";
import type { Part, ProcRecord, RxOrder, StructuredChart, Visit } from "../../src/connect/types";
import type { DeclarationView } from "../../src/facility/declaration";
import { evaluateG11, type ConfirmedAct, type G11About, type G11Claim, type G11Devices, type G11Finding, type G11Result, type G11Structured, type RxDay } from "../../src/generic/g11";
import { resolveRevision } from "../../src/engine/revisions";
import { withStructured } from "../../src/structured/g11-input";
import { readStructured } from "../../src/structured/read";
import { FR207_CELLS } from "../../src/structured/fr207-table";
import { isOutsideText, OUTSIDE_WORDS } from "../../src/structured/outside-words";
import type { SItem } from "../../src/structured/overlap";
import { RULE_CODES } from "../../src/structured/rule-codes";
import { hasTimeHint, TIME_HINT_WORDS } from "../../src/structured/time-hint";
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
  // 材料加算（EM §2-8 の別表「規則の候補で使うコード」の名称と区分番号）と、在宅酸素療法指導管理料（その他）
  for (const [code, name, kubun] of DEVICE_MASTER) si(code, name, "C", kubun);
  for (const [code, name, zaikei, mayaku] of [
    [D.carve, "カルベジロール錠１０ｍｇ「ニプロ」", "1", "0"],
    [D.geben, "ゲーベンクリーム１％", "6", "0"],
    [D.halcion, "ハルシオン０．２５ｍｇ錠", "1", "5"],
    [D.xylo, "キシロカイン注ポリアンプ０．５％　５ｍＬ", "4", "0"],
  ])
    put(db, "iyakuhin", SNAP, { code, name, zaikei, mayaku, unit_name: "錠" });
  return db;
}

/** 材料加算のコード・名称・区分番号（EM §2-8 の別表） */
const DEVICE_MASTER: [string, string, number][] = [
  ["114006310", "酸素ボンベ加算（携帯用酸素ボンベ）", 157],
  ["114006110", "酸素ボンベ加算（その他）", 157],
  ["114006210", "酸素濃縮装置加算", 158],
  ["114004910", "設置型液化酸素装置加算", 159],
  ["114005010", "携帯型液化酸素装置加算", 159],
  ["114015710", "呼吸同調式デマンドバルブ加算", 159],
  ["114005110", "在宅中心静脈栄養法用輸液セット加算", 160],
  ["114006710", "注入ポンプ加算", 161],
  ["114005210", "在宅経管栄養法用栄養管セット加算", 162],
  ["114006810", "人工呼吸器加算（陽圧式人工呼吸器）", 164],
  ["114009610", "人工呼吸器加算（人工呼吸器）", 164],
  ["114005510", "人工呼吸器加算（陰圧式人工呼吸器）", 164],
  ["114006910", "携帯型ディスポーザブル注入ポンプ加算", 166],
  ["114046010", "血糖自己測定器加算（３０回以上）（イ・１型糖尿病、膵全摘後以外）", 150],
  ["114046110", "血糖自己測定器加算（３０回以上）（ロ、ハ又はニ・１型糖尿病等）", 150],
  ["114006010", "血糖自己測定器加算（４０回以上）（イ・１型糖尿病、膵全摘後以外）", 150],
  ["114041610", "在宅酸素療法材料加算（その他）", 171],
  ["114003710", "在宅酸素療法指導管理料（その他）", 103],
];
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
  times?: G11Structured["times"];
  acts?: ConfirmedAct[];
  rxDays?: RxDay[];
  dispensing?: G11About["dispensing"];
  declaration?: DeclarationView;
  unmapped?: string[];
  /** さかのぼる月のカルテの文章を読めなかった（C-454） */
  pastTextsUnreadable?: boolean;
  /** 構造化データを渡さない（v32 の入力） */
  noStructured?: boolean;
  /** 材料加算の入力（段 19e） */
  devices?: G11Devices;
  /** 接続先が返したままの処方のオーダー・訪問（readStructured で読む。捨てた行・欠けの数を持つ） */
  rawOrders?: unknown[];
  rawVisits?: unknown[];
  /** 注射・処置の実施と、その当てたコードつきの行為 */
  procedures?: { records: ProcRecord[]; items: SItem[] };
};
/** 接続先が返したままの行を、読み出し（16-1）に通した種類 */
const readPart = <K extends "orders" | "visits">(k: K, items: unknown[]) => readStructured({ structured: { [k]: { status: "supported", items } } } as never)[k];
const emptyHistory = (): G11Structured["history"] => Array.from({ length: 12 }, (_, i) => ({ yearMonth: month(-(i + 1)), orders: sup<RxOrder>([]), items: [] }));
function about(o: Opt = {}): G11About {
  const rawOrders = o.rawOrders ? (readPart("orders", o.rawOrders) as Part<RxOrder>) : null;
  const orders = rawOrders?.status === "supported" ? rawOrders.items : o.orders === "unsupported" ? null : (o.orders ?? []);
  const chart: StructuredChart = {
    visits: o.rawVisits ? readPart("visits", o.rawVisits) : o.visits === "unsupported" || o.visits === undefined ? UNS : sup(o.visits),
    orders: rawOrders ?? (orders === null ? UNS : sup(orders)),
    procedures: o.procedures ? sup(o.procedures.records) : UNS,
    homeCare: UNS,
  };
  const items = [...(orders ? itemsOf(orders, o.unmapped) : []), ...(o.procedures?.items ?? [])];
  const S: G11Structured = { chart, items, history: o.history ?? emptyHistory(), lookbackMonths: 12, texts: o.texts ?? [], times: o.times ?? [], ...(o.devices ? { devices: o.devices } : {}), ...(o.pastTextsUnreadable ? { pastTextsUnreadable: true } : {}) };
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
    ...(o.noStructured ? (o.devices ? { devices: o.devices } : {}) : { structured: S }),
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
/** カルテの文章のある日。body は S・O・A・P の文、rx は処方の欄（text は両方を合わせた文、soap は S・O・A・P だけ） */
const text = (d: number | string, body: string, confirmed = true, rx = "") => ({ date: typeof d === "number" ? date(d) : d, text: [body, rx].filter(Boolean).join("\n"), soap: body, confirmed });

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
  cell("T3-出る", "v34（C-434）：請求にその日の麻薬等加算（処方料）120001310 だけがあり、処方料そのもののコード（120001210・120002610）がない日は、処方料の候補が出る（F100 の加算の行で「ある」と読まない）", () => {
    const db = rdb();
    const r = run(db, { units: [unit([R.mayakuShohoryo], 14)] }, { orders: inside14([[D.carve, 14]]) });
    expect(rules(r).filter((x) => x.codes.includes(R.shohoryo3)).map((x) => x.days.map((d) => d.date))).toEqual([[date(14)]]);
  });
  it("v34（C-434）：処方料の候補は、手順 2（候補どうしの背反）と手順 3（手書きのルール）にも 2 つの区分のコードの両方を渡す", () => {
    const db = rdb();
    // 候補の調剤料と処方料（区分 2）の背反（作り物の表）：区分 2 の側だけの関係でも、処方料の候補に添え書きが付く
    putHaihan(db, SNAP, 1, R.chozaiOral, R.shohoryo2, "1", "0");
    const r = run(db, { units: [] }, { orders: inside14([[D.carve, 14]]) });
    const f = rules(r).find((x) => x.codes.includes(R.shohoryo3))!;
    expect(notesOf(f).some((t) => t.includes("背反で算定できません"))).toBe(true);
    // 手順 3 に渡る処方料の候補の単位に、両方の区分のコードが入る
    const seen: string[][] = [];
    ok(
      evaluateG11({ units: [] }, rdb(), about({ orders: inside14([[D.carve, 14]]) }), rev, {
        step3: (cands) => {
          for (const c of cands) seen.push(c.units.flatMap((u) => u.items.map((it) => it.code)));
          return { notes: new Map(), scope: [] };
        },
      }),
    );
    expect(seen).toContainEqual(expect.arrayContaining([R.shohoryo3, R.shohoryo2]));
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
    gap[1] = { yearMonth: month(-2), orders: sup([order("p1", dateIn(-2, 3), "院外", [[D.carve, null]], 0)]), items: itemsOf([order("p1", dateIn(-2, 3), "院外", [[D.carve, null]], 0)]) };
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
    const o = order("p1", dateIn(-3, 8), "院外", [[D.geben, null]], 0);
    noDays[2] = { yearMonth: month(-3), orders: sup([o]), items: itemsOf([o]) };
    expect(n2Scope(run(db, kanri, base({ history: noDays })))).toEqual(["処方箋を交付しない場合の加算は見ていません（日数のない・リフィルの院外処方：1 件）"]);
    const refill = emptyHistory();
    refill[0] = { yearMonth: month(-1), orders: sup([order("p2", dateIn(-1, 8), "院外", [[D.carve, 28]], 2)]), items: [] };
    expect(n2Scope(run(db, kanri, base({ history: refill })))).toEqual(["処方箋を交付しない場合の加算は見ていません（日数のない・リフィルの院外処方：1 件）"]);
  });
  cell("T6-項目が取れず見ない-10", "リフィルの回数を接続先が返さない（null）院外のオーダーと、回数 1 の院外のオーダー（設計に定めがない）は、リフィルでないとみなさず「見ていません」（C-430＝C-450。16-4-5・L-201 の既定）。回数 0 は止めない", () => {
    const db = rdb();
    for (const refills of [null, 1]) {
      const h = emptyHistory();
      h[0] = { yearMonth: month(-1), orders: sup([order("p3", dateIn(-1, 8), "院外", [[D.carve, 28]], refills)]), items: [] };
      const r = run(db, kanri, base({ history: h }));
      expect(hasN2(r)).toBe(false);
      expect(n2Scope(r)).toEqual(["処方箋を交付しない場合の加算は見ていません（日数のない・リフィルの院外処方：1 件）"]);
    }
    const zero = emptyHistory();
    zero[0] = { yearMonth: month(-1), orders: sup([order("p3", dateIn(-1, 8), "院外", [[D.carve, 28]], 0)]), items: [] };
    expect(hasN2(run(db, kanri, base({ history: zero })))).toBe(true);
  });
  cell("T6-項目が取れず見ない-3", "さかのぼる月のカルテの文章を読めなかった（読む途中の例外）月は、文章を「ない」と読まず「前の文章を読めない」で「見ていません」（C-454）", () => {
    const db = rdb();
    const r = run(db, kanri, base({ pastTextsUnreadable: true }));
    expect(hasN2(r)).toBe(false);
    expect(n2Scope(r)).toEqual(["処方箋を交付しない場合の加算は見ていません（前の文章を読めない）"]);
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

// ───────────────────────────────────────────────────────────────────────────
// T7：患家診療時間加算（段 19d）

describe("T7 患家診療時間加算（114001470・114000970。R8-202〜R8-207）", () => {
  const visitDay = { units: [unit([VISIT], 5)] };
  const at = "2026-11-01T10:00:00+09:00";
  cell("T7-出る", "記録の時刻の差が 61 分以上で、その日の訪問診療料が請求にあれば、数量を分で出す。60 分では何も言わず、61 分で出て数量が 61", () => {
    const db = rdb();
    const r70 = run(db, visitDay, { visits: [visit("v1", 5, "訪問診療", "10:00", "11:10")] });
    const f = rules(r70)[0];
    expect(f.codes).toEqual([R.kakaVisit]);
    expect(f.days).toEqual([{ date: date(5), quote: "記録の時刻では 70 分です", notes: [], quantity: "70" }]);
    expect(f.text).toBe(
      "訪問の記録（5日）から、患家診療時間加算（訪問診療）が請求にありません。診療に当たっていた時間（移動・待ちの時間を除く）として合っているか確かめてください（R8-204）。同じ患家の 2 人目以降なら摘要欄の記載（820100847）が要ります。訪問診療の 3 人目以降は明文が 2 人目です（U-40）。算定できるか確かめてください",
    );
    expect(f.rule).toEqual({ basis: "visit", sources: ["電子カルテ"] });
    expect(rules(run(db, visitDay, { visits: [visit("v1", 5, "訪問診療", "10:00", "11:00")] }))).toEqual([]);
    expect(rules(run(db, visitDay, { visits: [visit("v1", 5, "訪問診療", "10:00", "11:01")] }))[0].days[0].quantity).toBe("61");
  });
  cell("T7-包括で出ない", "元の請求の行と G04 の言い切りの包括で隠れる", () => {
    const db = rdb();
    bundleUnderJutsugo(db, R.kakaVisit);
    const r = run(db, { units: [unit([VISIT, T.jutsugo], 5)] }, { visits: [visit("v1", 5, "訪問診療", "10:00", "11:10")] });
    expect(rules(r)).toEqual([]);
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "患家診療時間加算（訪問診療）", reason: "包括" }));
  });
  cell("T7-背反で出ない", "元の請求の行と G05 の言い切りの背反で隠れる", () => {
    const db = rdb();
    putHaihan(db, SNAP, 1, T.sansoKyunyu, R.kakaVisit, "1", "0");
    const r = run(db, { units: [unit([VISIT, T.sansoKyunyu], 5)] }, { visits: [visit("v1", 5, "訪問診療", "10:00", "11:10")] });
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "患家診療時間加算（訪問診療）", reason: "背反" }));
  });
  cell("T7-在医総管の月で出ない", "該当しない（包括されない）：在医総管の月にも出る", () => {
    const db = rdb();
    bundleUnderKanri(db);
    const r = run(db, { units: [unit([VISIT], 5), unit([KANRI], 5)] }, { visits: [visit("v1", 5, "訪問診療", "10:00", "11:10")] });
    expect(rules(r).map((f) => f.codes)).toContainEqual([R.kakaVisit]);
  });
  cell("T7-項目が取れず見ない-1", "訪問を受け取っていない・時刻の欠け・医療事務も入れていない日は「見ていません」と数", () => {
    const db = rdb();
    expect(run(db, visitDay, { visits: "unsupported" }).scope).toContain("患家診療時間加算は見ていません（時刻の分からない訪問の日：1 日）");
    expect(run(db, visitDay, { visits: [visit("v1", 5, "訪問診療", "10:00", null)] }).scope).toContain("患家診療時間加算は見ていません（時刻の分からない訪問の日：1 日）");
  });
  cell("T7-項目が取れず見ない-2", "基本の行も初診料・再診料も請求・候補にない日は出さず「見ていません：n 日」（C-413）", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { visits: [visit("v1", 5, "訪問診療", "10:00", "11:10")] });
    expect(rules(r)).toEqual([]);
    expect(r.scope).toContain("訪問診療料・往診料・初診料・再診料のない日の時間の加算は見ていません：1 日");
  });
  cell("T7-そのほか出ない", "60 分以下は何も言わない。日をまたぐ記録（終了が開始以前）は欠けの数に入る", () => {
    const db = rdb();
    const r = run(db, visitDay, { visits: [visit("v1", 5, "訪問診療", "10:00", "10:40")] });
    expect(rules(r)).toEqual([]);
    expect(r.scope.filter((s) => s.includes("時間の加算") || s.includes("患家診療時間加算"))).toEqual([]);
    expect(run(db, visitDay, { visits: [visit("v1", 5, "訪問診療", "23:30", "00:40")] }).scope).toContain("患家診療時間加算は見ていません（時刻の分からない訪問の日：1 日）");
  });
  it("訪問診療料・往診料がなく再診料だけの日の 70 分は、同じ患家の 2 人目以降の添え書きつきで出る（X-232。L-208）", () => {
    const db = rdb();
    const r = run(db, { units: [unit([SAISHIN], 5)] }, { visits: [visit("v1", 5, "訪問診療", "10:00", "11:10")] });
    const f = rules(r)[0];
    expect(f.codes).toEqual([R.kakaVisit]);
    expect(notesOf(f)).toEqual(["同じ患家の 2 人目以降として出しました。2 人目以降でなければ、訪問診療料・往診料を確かめてください。摘要欄の記載（820100847）が要ります"]);
  });
  it("訪問の記録がなく医療事務の時刻だけがあり、請求のその日に再診料だけ（同じ患家の 2 人目）の日は、黙って消さず「訪問の種類が分からない日」として「見ていません」に数える（C-432）", () => {
    const db = rdb();
    const r = run(db, { units: [unit([SAISHIN], 14)] }, { visits: "unsupported", times: [{ date: date(14), ref: null, start: "10:00", end: "11:10", by: "たいおう", at }] });
    expect(rules(r)).toEqual([]);
    expect(r.scope).toContain("患家診療時間加算は見ていません（訪問の種類が分からない日：1 日）");
    // 再診料もない日は、基本の行のない日として数える
    const none = run(db, { units: [] }, { visits: "unsupported", times: [{ date: date(14), ref: null, start: "10:00", end: "11:10", by: "たいおう", at }] });
    expect(none.scope).toContain("訪問診療料・往診料・初診料・再診料のない日の時間の加算は見ていません：1 日");
  });
  it("医療事務の時刻の ref が訪問の記録のどれにも当たらない・同じ日に 2 件以上で ref がないときは、別の訪問として足さず（二重に数えない）、黙って捨てずに「見ていません」に数える（C-442＝C-452）", () => {
    const db = rdb();
    const stale = run(db, visitDay, { visits: [visit("v1", 5, "訪問診療", "10:00", "10:40")], times: [{ date: date(5), ref: "v1-old", start: "10:00", end: "10:40", by: "たいおう", at }] });
    expect(rules(stale)).toEqual([]);
    expect(stale.scope).toContain("患家診療時間加算は見ていません（医療事務が入れた時刻を訪問の記録に結び付けられない日：1 日）");
    const two = run(db, { units: [{ ...unit([OUSHIN], 5), count: 2, days: dayArr(5, 5) }] }, { visits: [visit("v1", 5, "往診", null, null), visit("v2", 5, "往診", null, null)], texts: [text(5, "診療時間 1時間15分")], times: [{ date: date(5), ref: null, start: "10:00", end: "11:15", by: "たいおう", at }] });
    expect(two.scope).toContain("患家診療時間加算は見ていません（医療事務が入れた時刻を訪問の記録に結び付けられない日：1 日）");
    // 案内の日には、その日の訪問の記録（ref・種類）を並べ、どの訪問かを選べるようにする
    expect(two.visitTimeRefs).toEqual({ [date(5)]: [{ ref: "v1", kind: "往診" }, { ref: "v2", kind: "往診" }] });
  });
  it("往診は 114000970。請求に 114002470（特別往診）があれば出ない（L-179）", () => {
    const db = rdb();
    const v = { visits: [visit("v1", 5, "往診", "21:00", "22:10")] };
    expect(rules(run(db, { units: [unit([OUSHIN], 5)] }, v)).map((f) => f.codes)).toEqual([[R.kakaOushin]]);
    expect(rules(run(db, { units: [unit([OUSHIN, R.kakaOushinSpecial], 5)] }, v))).toEqual([]);
  });
  it("同じ日の 2 回の往診（U-38）：回ごとと合算を並べ、合算でだけ 61 分以上の日は「回ごとではどちらも 60 分以下です」と明記する（L-202）", () => {
    const db = rdb();
    const r = run(db, { units: [{ ...unit([OUSHIN], 5), count: 2, days: dayArr(5, 5) }] }, { visits: [visit("v1", 5, "往診", "09:00", "09:40"), visit("v2", 5, "往診", "20:00", "20:30")] });
    const f = rules(r)[0];
    expect(f.days[0].quote).toBe("回ごと 40 分・30 分、合算 70 分");
    expect(f.days[0].quantity).toBe("回ごと 40・30 分／合算 70 分");
    expect(notesOf(f)).toEqual(["回ごとと合算のどちらで数えるかは明文がありません（U-38）。回ごとではどちらも 60 分以下です"]);
  });
  it("医療事務の値と電子カルテの値が違うと、両方の分を文に出し、出どころの印を両方持つ（L-178）", () => {
    const db = rdb();
    const r = run(db, visitDay, { visits: [visit("v1", 5, "訪問診療", "10:00", "10:50")], times: [{ date: date(5), ref: "v1", start: "10:00", end: "11:10", by: "たいおう", at }] });
    const f = rules(r)[0];
    expect(f.days[0].quote).toBe("電子カルテでは 50 分、医療事務が入れた値では 70 分");
    expect(f.rule!.sources).toEqual(["電子カルテ", `医療事務が入れた（たいおう・${at}）`]);
    // 訪問の記録がない日は、医療事務の値を日で結ぶ
    const only = run(db, visitDay, { visits: [], times: [{ date: date(5), ref: null, start: "10:00", end: "11:10", by: "たいおう", at }] });
    expect(rules(only)[0].days[0].quote).toBe("記録の時刻では 70 分です");
  });
  it("時刻がなく文章に時間の語がない日は案内が出ず、語がある日と請求に時間の加算がある日だけ案内が出る（16-6。L-177）", () => {
    const db = rdb();
    const r = run(db, { units: [unit([VISIT], 5, 6, 7), unit([R.kakaVisit], 7)] }, { visits: "unsupported", texts: [text(5, "診療時間 1時間10分"), text(6, "経過良好"), text(7, "経過良好")] });
    expect(r.ruleGuides).toEqual(["5日・7日の訪問の開始・終了の時刻を入れると、患家診療時間加算を見ます"]);
    expect(r.visitTimeDays).toEqual([date(5), date(7)]);
    // 確かめていない文章の時間の語では案内しない
    expect(run(db, { units: [unit([VISIT], 5)] }, { visits: "unsupported", texts: [text(5, "診療時間 1時間10分", false)] }).ruleGuides).toEqual([]);
  });
  it("時間の語の規則は処方の欄に掛けない（S・O・A・P だけ）：処方の欄の「分3 毎食後」「疼痛時1錠」では案内が出ない（C-444）", () => {
    const db = rdb();
    const r = run(db, { units: [unit([VISIT], 5, 6)] }, { visits: "unsupported", texts: [text(5, "経過良好", true, "アムロジピン5mg 1T 分3 毎食後"), text(6, "経過良好", true, "ロキソプロフェン 疼痛時1錠")] });
    expect(r.ruleGuides).toEqual([]);
    expect(r.visitTimeDays).toEqual([]);
  });
  it("時間の語の一覧は決まった語で、数字と並んだときだけ当たる", () => {
    expect(TIME_HINT_WORDS).toEqual(["時間", "分", "時", ":"]);
    expect(hasTimeHint("診療時間が１時間１０分")).toBe(true);
    expect(hasTimeHint("10:00〜11:10")).toBe(true);
    expect(hasTimeHint("時間をかけて説明した")).toBe(false);
  });
  it("AI が取り出した「診療時間が１時間１０分」（114001470）は、時刻があれば規則の候補にたたまれ、時刻がなければ添え書きつきで今の候補に残る", () => {
    const db = rdb();
    const a = textAct(5, R.kakaVisit, "診療時間が１時間１０分", "診療行為");
    const withTime = run(db, visitDay, { visits: [visit("v1", 5, "訪問診療", "10:00", "11:10")], acts: [a] });
    expect(withTime.findings.filter((f) => f.codes.includes(R.kakaVisit)).map((f) => f.messageKey)).toEqual(["G11.missing_rule"]);
    expect(withTime.scope).toContain("規則で見る行為をたたみました：1 件");
    const noTime = run(db, visitDay, { visits: "unsupported", acts: [a] });
    const f = noTime.findings.filter((x) => x.codes.includes(R.kakaVisit));
    expect(f.map((x) => x.messageKey)).toEqual(["G11.missing"]);
    expect(notesOf(f[0])).toContain("時刻が分かれば規則で確かめます");
  });
  it("施設基準（G10）で算定できないと決まるものも出ない（手順 1 のまま）", () => {
    const db = rdb();
    db.prepare("UPDATE shinryo SET shisetsu_g1 = '721' WHERE snapshot = ? AND code = ?").run(SNAP, R.kakaVisit);
    const decl: DeclarationView = { held: (k) => (k === "721" ? { v: "not", reason: "notified_no" } : { v: "held" }), nameOf: () => null };
    const r = run(db, visitDay, { visits: [visit("v1", 5, "訪問診療", "10:00", "11:10")], declaration: decl });
    expect(rules(r)).toEqual([]);
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "患家診療時間加算（訪問診療）", reason: "施設基準" }));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T8〜T15：在宅療養指導管理材料加算（段 19e。16-4-7）

/** 機器のコード（EM §2-8 の別表） */
const M = {
  c157_1: "114006310",
  c157_2: "114006110",
  c158: "114006210",
  c159_1: "114004910",
  c159_2: "114005010",
  c160: "114005110",
  c161: "114006710",
  c162: "114005210",
  c164_1: "114006810",
  c164_2: "114009610",
  c164_3: "114005510",
  c166: "114006910",
  c150_2i: "114046010",
  c150_2ro: "114046110",
  c150_3i: "114006010",
  c171_2: "114041610",
} as const;
const C103_2 = rev.codes.C103_2.primary;
const SRC = "医療事務が入れた（たいおう・2026-11-01T10:00:00+09:00）";
type DRow = G11Devices["rows"][number];
const drow = (kind: DRow["kind"], more: Partial<DRow> = {}): DRow => ({ kind, fromMonth: month(-6), source: SRC, ...more });
/** 確かめた患者の機器（前の 2 か月の請求は、どちらも材料加算なしで取り込んである） */
const devs = (rows: DRow[], more: Partial<G11Devices> = {}): G11Devices => ({ checked: true, rows, pending: [], prev: [1, 2].map((n) => ({ yearMonth: month(-n), units: [] })), c103: false, ...more });
const visit5 = (...codes: string[]) => ({ units: [unit([VISIT], 5), ...codes.map((c) => unit([c], 5))] });
const devFindings = (r: ReturnType<typeof run>) => r.findings.filter((f) => f.rule?.basis === "device");
const devKeys = (r: ReturnType<typeof run>) => devFindings(r).map((f) => `${f.messageKey === "G11.missing_either" ? "either " : ""}${f.codes.join("+")}`);
/** 作り物の包括の親（在医総管。補助マスターのグループ C002001・月）にコードを包括させる（材料加算は在医総管の包括に入らないので、包括で隠れる升だけで使う） */
const bundleUnderKanriCode = (db: Database.Database, code: string) => put(db, "houkatsu", SNAP, { ...LIVE, group_no: "C002001", code, tokurei: "0" });
/** 前の月の請求の単位（コードと対象の月のコメント） */
const prevUnit = (n: number, codes: string[], comments: string[]) => ({ yearMonth: month(-n), units: [{ codes, comments }] });
/** 対象の月が当月になるコメント（前の月の請求の「翌月分」・前々月の請求の「翌々月分」。EM §2-10 表 1-b） */
const NEXT = "820100124";
const NEXT2 = "820100123";

describe("T8 酸素の機器（C157・C158・C159・C159-2。R8-23・R8-24・R8-211〜R8-214・R8-216）", () => {
  cell("T8-出る", "機器の行が効き、請求にそのコードも同じ組の相手もなければ、機器のコードの候補（チアノーゼ型の添え書き）。併用の組 (b) は「どれか 1 つ」の 1 件", () => {
    const db = rdb();
    const r = run(db, visit5(), { devices: devs([drow("C158")]) });
    const f = devFindings(r)[0];
    expect(f.codes).toEqual([M.c158]);
    expect(f.messageKey).toBe("G11.missing_rule");
    expect(f.text).toMatch(/^患者の機器から、酸素濃縮装置加算が請求にありません。/);
    expect(f.rule).toEqual({ basis: "device", sources: [SRC] });
    expect(notesOf(f)).toContain("チアノーゼ型先天性心疾患の患者には算定しません");
    expect(f.text).not.toMatch(/点|円/);
    // 請求にあれば出ない
    expect(devFindings(run(db, visit5(M.c158), { devices: devs([drow("C158")]) }))).toEqual([]);
    // (b) ボンベ（携帯用以外）と設置型液化酸素装置：どれか 1 つ
    expect(devKeys(run(db, visit5(), { devices: devs([drow("C157_2"), drow("C159_1")]) }))).toEqual([`either ${M.c157_2}+${M.c159_1}`]);
    // (c) 携帯用ボンベと携帯型液化酸素装置：どれか 1 つ。(d) 設置型と携帯型の液化酸素は両方
    expect(devKeys(run(db, visit5(), { devices: devs([drow("C157_1"), drow("C159_2")]) }))).toEqual([`either ${M.c157_1}+${M.c159_2}`]);
    expect(devKeys(run(db, visit5(), { devices: devs([drow("C159_1"), drow("C159_2")]) })).sort()).toEqual([M.c159_1, M.c159_2].sort());
    // 濃縮装置と携帯用ボンベ（K1・K12 の組）は組に当たらず、両方
    expect(devKeys(run(db, visit5(), { devices: devs([drow("C158"), drow("C157_1")]) })).sort()).toEqual([M.c157_1, M.c158].sort());
  });
  cell("T8-包括で出ない", "元の請求の行と G04 の言い切りの包括で隠れ、言わなかったものに包括の理由で並ぶ（作った包括の行）", () => {
    const db = rdb();
    bundleUnderKanriCode(db, M.c158);
    const r = run(db, { units: [unit([VISIT], 5), unit([KANRI], 5)] }, { devices: devs([drow("C158")]) });
    expect(devFindings(r)).toEqual([]);
    expect(r.hidden).toContainEqual(expect.objectContaining({ written: "酸素濃縮装置加算", reason: "包括", check: "G04" }));
  });
  cell("T8-背反で出ない", "C158 が効く月の C157_2 は出さない（R8-216 (a)）。請求に同じ組の相手がある月は勧めず、食い違いの 1 件（C-401）", () => {
    const db = rdb();
    expect(devKeys(run(db, visit5(), { devices: devs([drow("C158"), drow("C157_2")]) }))).toEqual([M.c158]);
    // 請求に 114006110（ボンベ 2）があり機器の行が C158：114006210 を勧めない
    const r = run(db, visit5(M.c157_2), { devices: devs([drow("C158")]) });
    const f = devFindings(r);
    expect(f.map((x) => x.text)).toEqual(["患者の機器では酸素濃縮装置加算、請求は酸素ボンベ加算（その他）です。どちらが正しいか確かめてください"]);
    expect(f[0].certainty).toBe("条件つき");
  });
  cell("T8-在医総管の月で出ない", "該当しない（材料加算は投薬の費用でない）：在医総管の月にも出る", () => {
    const db = rdb();
    bundleUnderKanri(db);
    expect(devKeys(run(db, { units: [unit([VISIT], 5), unit([KANRI], 5)] }, { devices: devs([drow("C158")]) }))).toEqual([M.c158]);
  });
  cell("T8-項目が取れず見ない", "機器を確かめていない患者は見ず、点検の範囲に数える。指導管理料（C100〜C121）の行がある月だけ案内が出る", () => {
    const db = rdb();
    const unchecked = devs([], { checked: false });
    const r = run(db, visit5(C103_2), { devices: unchecked });
    expect(devFindings(r)).toEqual([]);
    expect(r.scope).toContain("在宅療養指導管理材料加算は、機器を確かめていない患者なので見ていません：1 件");
    expect(r.ruleGuides).toContain("患者の情報で在宅療養の機器を確かめると、在宅療養指導管理材料加算を見ます");
    expect(run(db, visit5(), { devices: unchecked }).ruleGuides).toEqual([]);
  });
  cell("T8-そのほか出ない", "前の 2 か月の請求で、同じ単位のどれかのコードで当月分が算定済みなら出さない。コードが違えば点検の範囲に 1 行（W-17・C-411）", () => {
    const db = rdb();
    // 9 月の請求にボンベ 2 と 3 回分のコメント（9〜11 月分）、10 月から機器の行が C158
    const prev = [prevUnit(1, [M.c157_2], [NEXT]), { yearMonth: month(-2), units: [] }];
    const r = run(db, visit5(), { devices: devs([drow("C158", { fromMonth: YM })], { prev }) });
    expect(devFindings(r)).toEqual([]);
    expect(r.scope).toContain("前の月に酸素ボンベ加算（その他）で当月分を算定済みです");
    // 同じコードなら黙って出さない
    const same = run(db, visit5(), { devices: devs([drow("C158")], { prev: [prevUnit(1, [M.c158], [NEXT]), prevUnit(2, [], [])] }) });
    expect(devFindings(same)).toEqual([]);
    expect(same.scope.filter((s) => s.startsWith("前の月に"))).toEqual([]);
    // 前の 2 か月の請求がなければ、候補に添え書き
    const none = run(db, visit5(), { devices: devs([drow("C158")], { prev: [] }) });
    expect(notesOf(devFindings(none)[0])).toContain("前の月に当月分を算定していないか確かめてください");
  });
});

describe("T9 在宅酸素療法材料加算 2（C171_2。R8-215）", () => {
  cell("T9-出る", "酸素の機器が効き、その月に C103 の 2 の指導管理（請求の行か、在宅療養の指示）がある月に出る。指示だけの月は U-44 の添え書き", () => {
    const db = rdb();
    const r = run(db, visit5(C103_2, M.c158), { devices: devs([drow("C158")]) });
    expect(devKeys(r)).toEqual([M.c171_2]);
    expect(notesOf(devFindings(r)[0])).not.toContain("C103 の 2 を算定しない月でも算定できるかは明文がありません（U-44）");
    const byOrder = run(db, visit5(M.c158), { devices: devs([drow("C158")], { c103: true }) });
    expect(devKeys(byOrder)).toEqual([M.c171_2]);
    expect(notesOf(devFindings(byOrder)[0])).toContain("C103 の 2 を算定しない月でも算定できるかは明文がありません（U-44）");
  });
  cell("T9-包括で出ない", "元の請求の行と G04 の言い切りの包括で隠れる", () => {
    const db = rdb();
    bundleUnderKanriCode(db, M.c171_2);
    const r = run(db, { units: [unit([VISIT], 5), unit([KANRI], 5), unit([C103_2], 5), unit([M.c158], 5)] }, { devices: devs([drow("C158")]) });
    expect(devFindings(r)).toEqual([]);
    expect(r.hidden).toContainEqual(expect.objectContaining({ reason: "包括", check: "G04" }));
  });
  cell("T9-背反で出ない", "元の請求の行と G05 の言い切りの背反で隠れる", () => {
    const db = rdb();
    putHaihan(db, SNAP, 2, C103_2, M.c171_2, "1", "0");
    const r = run(db, visit5(C103_2, M.c158), { devices: devs([drow("C158")]) });
    expect(devFindings(r)).toEqual([]);
    expect(r.hidden).toContainEqual(expect.objectContaining({ reason: "背反", check: "G05" }));
  });
  cell("T9-在医総管の月で出ない", "該当しない：在医総管の月にも出る", () => {
    const db = rdb();
    bundleUnderKanri(db);
    expect(devKeys(run(db, { units: [unit([VISIT], 5), unit([KANRI], 5), unit([C103_2], 5), unit([M.c158], 5)] }, { devices: devs([drow("C158")]) }))).toEqual([M.c171_2]);
  });
  cell("T9-項目が取れず見ない", "C103 の 2 の指導管理の行も指示もない月・機器を確かめていない患者は「見ていません」", () => {
    const db = rdb();
    const r = run(db, visit5(M.c158), { devices: devs([drow("C158")]) });
    expect(devFindings(r)).toEqual([]);
    expect(r.scope).toContain("在宅酸素療法材料加算は見ていません（C103 の 2 の指導管理の行も在宅療養の指示もない）");
    expect(run(db, visit5(C103_2), { devices: devs([], { checked: false }) }).scope).toContain("在宅療養指導管理材料加算は、機器を確かめていない患者なので見ていません：1 件");
  });
  cell("T9-そのほか出ない", "酸素の機器が効かない月は出さない", () => {
    const db = rdb();
    expect(devKeys(run(db, visit5(C103_2), { devices: devs([drow("C160")]) }))).toEqual([M.c160]);
    // 機器を確かめた（機器なし）患者で、C103 の 2 の行だけがある月
    const r = run(db, visit5(C103_2), { devices: devs([]) });
    expect(devKeys(r)).toEqual([]);
    expect(r.scope.filter((s) => s.startsWith("在宅酸素療法材料加算"))).toEqual([]);
  });
});

/** T10・T11・T12・T14：同じコードで見る機器（添え書きだけが違う） */
for (const [row, kind, code, label, note] of [
  ["T10", "C160", M.c160, "在宅中心静脈栄養法用輸液セット加算", "保険薬局が輸液セットを出していれば算定しません（R8-210）"],
  ["T11", "C161", M.c161, "注入ポンプ加算", "対象の療法（R8-218 のイ〜ホ）に当たるか確かめてください"],
  ["T12", "C162", M.c162, "在宅経管栄養法用栄養管セット加算", "C105 の対象（成分栄養。単なる流動食は当たらない）か確かめてください"],
  ["T14", "C166", M.c166, "携帯型ディスポーザブル注入ポンプ加算", null],
] as const) {
  describe(`${row} ${label}`, () => {
    cell(`${row}-出る`, `機器の行が効き、請求になければ出る${note ? `（添え書き：${note}）` : ""}`, () => {
      const db = rdb();
      const r = run(db, visit5(), { devices: devs([drow(kind)]) });
      const f = devFindings(r)[0];
      expect(f.codes).toEqual([code]);
      expect(f.text).toMatch(new RegExp(`^患者の機器から、${label}が請求にありません。`));
      if (note) expect(notesOf(f)).toContain(note);
      if (kind === "C166") {
        // 注入ポンプと同じ月なら両方を出し、両方に同じ文（U-48。L-204）
        const both = devFindings(run(db, visit5(), { devices: devs([drow("C161"), drow("C166")]) }));
        expect(both.map((x) => x.codes[0]).sort()).toEqual([M.c161, M.c166].sort());
        for (const x of both) expect(notesOf(x)).toContain("同じ月の併算定は明文がありません（U-48）");
      }
    });
    cell(`${row}-包括で出ない`, "元の請求の行と G04 の言い切りの包括で隠れる", () => {
      const db = rdb();
      bundleUnderKanriCode(db, code);
      const r = run(db, { units: [unit([VISIT], 5), unit([KANRI], 5)] }, { devices: devs([drow(kind)]) });
      expect(devFindings(r)).toEqual([]);
      expect(r.hidden).toContainEqual(expect.objectContaining({ written: label, reason: "包括", check: "G04" }));
    });
    cell(`${row}-背反で出ない`, "元の請求の行と G05 の言い切りの背反で隠れる", () => {
      const db = rdb();
      putHaihan(db, SNAP, 2, VISIT, code, "1", "0");
      const r = run(db, visit5(), { devices: devs([drow(kind)]) });
      expect(devFindings(r)).toEqual([]);
      expect(r.hidden).toContainEqual(expect.objectContaining({ written: label, reason: "背反", check: "G05" }));
    });
    cell(`${row}-在医総管の月で出ない`, "該当しない：在医総管の月にも出る", () => {
      const db = rdb();
      bundleUnderKanri(db);
      expect(devKeys(run(db, { units: [unit([VISIT], 5), unit([KANRI], 5)] }, { devices: devs([drow(kind)]) }))).toEqual([code]);
    });
    cell(`${row}-項目が取れず見ない`, "機器を確かめていない患者は「見ていません」", () => {
      const db = rdb();
      const r = run(db, visit5(), { devices: devs([], { checked: false }) });
      expect(devFindings(r)).toEqual([]);
      expect(r.scope).toContain("在宅療養指導管理材料加算は、機器を確かめていない患者なので見ていません：1 件");
    });
    cell(`${row}-そのほか出ない`, "前の 2 か月の請求で当月分が算定済み（前々月の翌々月分）なら出さない", () => {
      const db = rdb();
      expect(devFindings(run(db, visit5(), { devices: devs([drow(kind)], { prev: [prevUnit(1, [], []), prevUnit(2, [code], [NEXT2])] }) }))).toEqual([]);
    });
  });
}

describe("T13 人工呼吸器（C164_1〜C164_3。R8-226）", () => {
  cell("T13-出る", "機器の行のコード 1 つ。2 つ以上効けば「どれか 1 つ」", () => {
    const db = rdb();
    expect(devKeys(run(db, visit5(), { devices: devs([drow("C164_2")]) }))).toEqual([M.c164_2]);
    expect(devKeys(run(db, visit5(), { devices: devs([drow("C164_1"), drow("C164_3")]) }))).toEqual([`either ${M.c164_1}+${M.c164_3}`]);
  });
  cell("T13-包括で出ない", "元の請求の行と G04 の言い切りの包括で隠れる", () => {
    const db = rdb();
    bundleUnderKanriCode(db, M.c164_2);
    const r = run(db, { units: [unit([VISIT], 5), unit([KANRI], 5)] }, { devices: devs([drow("C164_2")]) });
    expect(devFindings(r)).toEqual([]);
    expect(r.hidden).toContainEqual(expect.objectContaining({ reason: "包括", check: "G04" }));
  });
  cell("T13-背反で出ない", "請求に C164 のほかの区分がある（114006810 と機器の行 C164_2）と勧めず食い違いの 1 件（C-401）。元の請求の行と G05 の言い切りの背反でも隠れる", () => {
    const db = rdb();
    expect(devFindings(run(db, visit5(M.c164_1), { devices: devs([drow("C164_2")]) })).map((f) => f.text)).toEqual([
      "患者の機器では人工呼吸器加算（人工呼吸器）、請求は人工呼吸器加算（陽圧式人工呼吸器）です。どちらが正しいか確かめてください",
    ]);
    putHaihan(db, SNAP, 2, VISIT, M.c164_2, "1", "0");
    expect(run(db, visit5(), { devices: devs([drow("C164_2")]) }).hidden).toContainEqual(expect.objectContaining({ reason: "背反", check: "G05" }));
  });
  cell("T13-在医総管の月で出ない", "該当しない：在医総管の月にも出る", () => {
    const db = rdb();
    bundleUnderKanri(db);
    expect(devKeys(run(db, { units: [unit([VISIT], 5), unit([KANRI], 5)] }, { devices: devs([drow("C164_2")]) }))).toEqual([M.c164_2]);
  });
  cell("T13-項目が取れず見ない", "機器を確かめていない患者は「見ていません」", () => {
    const db = rdb();
    expect(run(db, visit5(), { devices: devs([], { checked: false }) }).scope).toContain("在宅療養指導管理材料加算は、機器を確かめていない患者なので見ていません：1 件");
  });
  cell("T13-そのほか出ない", "前の 2 か月の請求で C164 のどれかの区分で当月分が算定済みなら出さず、区分が違えば点検の範囲に 1 行（C-411）", () => {
    const db = rdb();
    const r = run(db, visit5(), { devices: devs([drow("C164_2", { fromMonth: YM })], { prev: [prevUnit(1, [M.c164_1], [NEXT]), prevUnit(2, [], [])] }) });
    expect(devFindings(r)).toEqual([]);
    expect(r.scope).toContain("前の月に人工呼吸器加算（陽圧式人工呼吸器）で当月分を算定済みです");
  });
});

describe("T15 血糖自己測定器（C150_1〜C150_7。R8-221・R8-222。W-23）", () => {
  const c150 = (band: string, patientClass: "イ" | "ロ" = "イ") => drow("C150", { c150: { band, patientClass } });
  cell("T15-出る", "機器の行の区分と患者の区分で 1 つのコード（添え書き：指示の回数で区分を選んだ）", () => {
    const db = rdb();
    const f = devFindings(run(db, visit5(), { devices: devs([c150("C150_2")]) }))[0];
    expect(f.codes).toEqual([M.c150_2i]);
    expect(notesOf(f)).toContain("指示の回数で区分を選びました（U-46）");
    expect(devKeys(run(db, visit5(), { devices: devs([c150("C150_2", "ロ")]) }))).toEqual([M.c150_2ro]);
  });
  cell("T15-包括で出ない", "元の請求の行と G04 の言い切りの包括で隠れる", () => {
    const db = rdb();
    bundleUnderKanriCode(db, M.c150_2i);
    const r = run(db, { units: [unit([VISIT], 5), unit([KANRI], 5)] }, { devices: devs([c150("C150_2")]) });
    expect(devFindings(r)).toEqual([]);
    expect(r.hidden).toContainEqual(expect.objectContaining({ reason: "包括", check: "G04" }));
  });
  cell("T15-背反で出ない", "請求に 114006010（40 回以上 イ）があり機器の行が C150_2：114046010 を勧めず食い違いの 1 件（C-401）。G05 の言い切りの背反でも隠れる", () => {
    const db = rdb();
    const f = devFindings(run(db, visit5(M.c150_3i), { devices: devs([c150("C150_2")]) }));
    expect(f.map((x) => x.codes)).toEqual([[M.c150_3i, M.c150_2i]]);
    expect(f[0].text).toMatch(/、請求は血糖自己測定器加算（４０回以上）/);
    putHaihan(db, SNAP, 2, VISIT, M.c150_2i, "1", "0");
    expect(run(db, visit5(), { devices: devs([c150("C150_2")]) }).hidden).toContainEqual(expect.objectContaining({ reason: "背反", check: "G05" }));
  });
  cell("T15-在医総管の月で出ない", "該当しない：在医総管の月にも出る", () => {
    const db = rdb();
    bundleUnderKanri(db);
    expect(devKeys(run(db, { units: [unit([VISIT], 5), unit([KANRI], 5)] }, { devices: devs([c150("C150_2")]) }))).toEqual([M.c150_2i]);
  });
  cell("T15-項目が取れず見ない", "機器を確かめていない患者、区分か患者の区分が空の行は「見ていません」", () => {
    const db = rdb();
    expect(run(db, visit5(), { devices: devs([], { checked: false }) }).scope).toContain("在宅療養指導管理材料加算は、機器を確かめていない患者なので見ていません：1 件");
    const r = run(db, visit5(), { devices: devs([drow("C150")]) });
    expect(devFindings(r)).toEqual([]);
    expect(r.scope).toContain("血糖自己測定器加算は、機器の行の区分か患者の区分が空なので見ていません：1 件");
  });
  cell("T15-そのほか出ない", "9 月に C150_2 の 3 回分、10 月の機器の行が C150_3：候補を出さず、点検の範囲に「前の月に〔区分〕を算定済み。月ごとの区分は明文がありません」（L-205）", () => {
    const db = rdb();
    const r = run(db, visit5(), { devices: devs([drow("C150", { fromMonth: YM, c150: { band: "C150_3", patientClass: "イ" } })], { prev: [prevUnit(1, [M.c150_2i], [NEXT]), prevUnit(2, [], [])] }) });
    expect(devFindings(r)).toEqual([]);
    expect(r.scope).toContain("前の月に血糖自己測定器加算（３０回以上）（イ・１型糖尿病、膵全摘後以外）を算定済み。月ごとの区分は明文がありません");
  });
});

describe("材料加算の欄（16-3・16-4-7）", () => {
  it("文章の「酸素ボンベ使用」（114006110）は候補にならず「患者の情報の機器で見ます」にたたまれる", () => {
    const db = rdb();
    const a = textAct(5, M.c157_2, "酸素ボンベ使用", "診療行為");
    const r = run(db, visit5(), { acts: [a], devices: devs([]) });
    expect(r.findings.filter((f) => f.codes.includes(M.c157_2))).toEqual([]);
    expect(r.scope).toContain("患者の情報の機器で見る行為をたたみました：1 件");
    // 機器を確かめていない患者では、機器の入力の案内が出る（16-6）
    expect(run(db, visit5(), { acts: [a], devices: devs([], { checked: false }) }).ruleGuides).toContain("患者の情報で在宅療養の機器を確かめると、在宅療養指導管理材料加算を見ます");
  });
  it("材料加算の欄の上に、注入器加算・注入器用注射針加算と、ほかの医療機関の指導管理料を見ていないことを 1 行ずつ出す（L-181・L-186）", () => {
    const db = rdb();
    expect(run(db, visit5(), { devices: devs([drow("C158")]) }).materialNotes).toEqual(["注入器加算・注入器用注射針加算は見ていません", "ほかの医療機関が在宅療養指導管理料を算定している患者かは見ていません"]);
    expect(run(db, visit5(), {}).materialNotes).toEqual([]);
  });
  it("確かめていない変える案がある患者は、関わる機器の候補に添え書きし、件数の案内を出す（判定には使わない）", () => {
    const db = rdb();
    const r = run(db, visit5(), { devices: devs([drow("C158")], { pending: ["C158"] }) });
    expect(notesOf(devFindings(r)[0])).toContain("電子カルテから確かめていない変える案があります");
    expect(r.ruleGuides).toContain("電子カルテから届いた機器の変える案が 1 件あります。患者の情報で入れるか決めてください");
  });
  it("9 月の請求に 114006110（ボンベ 2）と 3 回分のコメント（9〜11 月分）、10 月から機器の行が C158：10 月に C158 を勧めない（C-411＝X-240）", () => {
    const db = rdb();
    const prev = [{ yearMonth: month(-1), units: [{ codes: [M.c157_2], comments: ["820100122", NEXT, NEXT2] }] }, prevUnit(2, [], [])];
    const r = run(db, visit5(), { devices: devs([drow("C158", { fromMonth: YM })], { prev }) });
    expect(devKeys(r)).toEqual([]);
    expect(r.scope).toContain("前の月に酸素ボンベ加算（その他）で当月分を算定済みです");
  });
});

describe("対応表にないコード（16-2・16-6・16-7。C-443）", () => {
  it("判定の外になった独自コードの数を G11 の結果に持ち、上の案内に「対応表にないコード n 件」の 1 行を出す（患者・日は出さない）", () => {
    const db = rdb();
    const r = run(db, { units: [] }, { orders: inside14([[D.carve, 14], [D.geben, 14]]), unmapped: [D.geben], texts: [text(14, "定期処方")] });
    expect(r.unmappedCodes).toBe(1);
    expect(r.ruleGuides).toContain("電子カルテの対応表にないコードが 1 件あります。下の欄で対応を選ぶと、次の点検から判定に使います");
    const none = run(db, { units: [] }, { orders: inside14([[D.carve, 14]]), texts: [text(14, "定期処方")] });
    expect(none.unmappedCodes).toBe(0);
    expect(none.ruleGuides.filter((g) => g.includes("対応表"))).toEqual([]);
  });
});

describe("構造化データのない請求（v32 の入力）", () => {
  it("機器を確かめた患者は、構造化データがなくても患者の機器から材料加算を見る（v34 の 16-4-1。C-440）", () => {
    const db = rdb();
    const r = ok(evaluateG11({ units: [unit([VISIT], 5)] }, db, about({ noStructured: true, acts: [textAct(5, T.sansoKyunyu, "酸素吸入", "処置")], devices: devs([drow("C158")]) }), rev));
    expect(rules(r).map((f) => f.codes)).toContainEqual([M.c158]);
    // 材料加算は見ているので、点検の範囲の 1 行は材料加算を「見ていません」と言わない
    expect(r.scope.filter((s) => s.startsWith("電子カルテの構造化データがない"))).toEqual(["電子カルテの構造化データがないので、処方箋を交付しない場合の加算・患家診療時間加算は見ていません"]);
  });
  it("規則の候補を出さず、点検の範囲に「電子カルテの構造化データがないので…見ていません」の 1 行だけを出す（v34。C-433。指摘の数は増えない）", () => {
    const db = rdb();
    const act = textAct(14, T.sansoKyunyu, "酸素吸入", "処置");
    const r = ok(evaluateG11({ units: [unit([KANRI, VISIT], 14)] }, db, about({ noStructured: true, acts: [act] }), rev));
    expect(rules(r)).toEqual([]);
    expect(r.scope.filter((s) => s.includes("処方箋を交付しない") || s.includes("時間の加算") || s.includes("材料加算"))).toEqual(["電子カルテの構造化データがないので、処方箋を交付しない場合の加算・患家診療時間加算・材料加算は見ていません"]);
    expect(r.scope.filter((s) => s.startsWith("電子カルテの構造化データがない"))).toHaveLength(1);
  });
});

describe("反証 round-69（X-280〜X-284）", () => {
  /** 接続先の院外のオーダーで ref のない行（読み出しで捨てる行） */
  const badOutside = (d: string) => ({ ref: null, date: d, place: "院外", refills: 0, drugs: [{ code: { system: "rece", value: D.carve }, name: "薬", days: 14, quantity: "1錠" }] });
  const rawInside14 = () => inside14([[D.carve, 14]]);
  it("X-283：接続先の訪問の存在しない時刻（10:99）は欠けとして扱い、時間の加算の計算に使わない", () => {
    const db = rdb();
    const r = run(db, { units: [unit([VISIT], 5)] }, { rawVisits: [{ ref: "v1", date: date(5), kind: "訪問診療", start: "10:99", end: "12:40" }] });
    expect(rules(r)).toEqual([]);
    expect(r.scope).toContain("患家診療時間加算は見ていません（時刻の分からない訪問の日：1 日）");
    expect(readPart("visits", [{ ref: "v1", date: date(5), kind: "訪問診療", start: "24:00", end: "9:5" }])).toEqual({ status: "supported", items: [{ ref: "v1", date: date(5), kind: "訪問診療", start: null, end: null }], gaps: { start: 1, end: 1 } });
  });
});

describe("FR-207 の表の升（16-4-8）", () => {
  it("FR207_CELLS の T1〜T15 の全部の升の id に、テストが 1 件以上ある（升を空にしない。L-197・C-413）", () => {
    expect(FR207_CELLS.length).toBe(15 * 6 + 3 + 9 + 1);
    expect(FR207_CELLS.filter((id) => !covered.has(id))).toEqual([]);
  });
});
