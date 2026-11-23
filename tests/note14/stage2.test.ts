// 段 17j：注14 の計算の道具の 2 段目を手入力で（design.md §15-13）。様式と同じ並びの欄、依り方の定数から決まる欄の数、整数の不等式、4 つ全部で判定、U-31〜U-34 の両方の読み
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import { evaluate, periodOf, shiftMonth, toolConstsOf, type Evaluation, type Stage1Input } from "../../src/note14/evaluate";
import { FIELDS, fieldKeys, type FieldDef } from "../../src/note14/readings";
import { note14WorksheetBody } from "../../src/server/schemas/note14";
import { month } from "../helpers/period";

const M = month(1);
const K = toolConstsOf(resolveRevision(M).consts.note14)!;
const P = periodOf(M, K);
const T = K.visitThreshold;
const over: Stage1Input = { months: P.short.from ? [0, 1, 2].map((i) => ({ month: shiftMonth(P.short.from, i), kou: i === 0 ? T : 0, otsuExtra: 0, source: "manual" as const })) : [], gansou: 0, secondPatient: 0, special: "none", institutions: [] };
const under: Stage1Input = { ...over, months: over.months.map((m) => ({ ...m, kou: 0 })) };

/** 4 つ全部を満たす 2 段目（どの読みでも同じ値） */
const base = (): Record<string, number | null> => {
  const v: Record<string, number> = { referral: K.referralMin, mitoriHome: K.mitoriMin, mitoriFacility: 0, mitoriHospital: 0, jushoji: 0, c002: 50, c0022: 50, excluded: 0, care: 50 };
  return Object.fromEntries(fieldKeys().map((f) => [f.key, v[f.field.id]]));
};
const set = (v: Record<string, number | null>, id: string, n: number | null, where: (key: string) => boolean = () => true) => {
  for (const key of Object.keys(v)) if (key.split(":")[0] === id && where(key)) v[key] = n;
  return v;
};
const run = (values: Record<string, number | null>, openedOn: string | null = null, s1: Stage1Input = over) => evaluate({ stage1: { ...s1, openedOn }, stage2: { values } }, K, P);
const done = (e: Evaluation) => {
  if (e.status !== "done") throw new Error(`結果が出ていない: ${e.missing.join("、")}`);
  return e;
};

describe("2 段目の開き方と欄", () => {
  it("1 段目で門以上の読みがないときは 2 段目が開かない（2 段目の欄が空でも結果が出る）", () => {
    const e = evaluate({ stage1: under }, K, P);
    expect([e.stage2Open, done(e).result]).toEqual([false, "meets"]);
  });
  it("欄の並びが、EM R8-197〜R8-200 の出どころの様式19の2 の欄の順と同じ", () => {
    const EM = readFileSync(path.join(__dirname, "../../design/iji-context/sources/evidence-master-iji-context.md"), "utf8").split("\n");
    const circled = "①②③④⑤⑥";
    const order = (f: FieldDef) => [Number(f.form[2]), f.form.length > 4 ? circled.indexOf(f.form[4]) : -1];
    const sorted = [...FIELDS].sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
    expect(FIELDS.map((f) => f.id)).toEqual(sorted.map((f) => f.id));
    for (const f of FIELDS) expect(EM.find((l) => l.startsWith(`| ${f.requirement} |`)), f.id).toContain(`様式19の2 ${f.form.slice(0, 4)}`);
    // 要件の順（R8-197 → R8-200）も様式の順
    expect(FIELDS.map((f) => f.requirement)).toEqual([...FIELDS.map((f) => f.requirement)].sort());
  });
  it("X-174（C-321）・C-343：①② は 2 欄ずつ、③⑤ は 4 欄ずつ、看取りは 3 欄（読みで分けない）、紹介元は 2 欄。欄の数は依り方の定数から決まる（定数を変えると欄の数が変わる）", () => {
    const count = (defs = FIELDS) => Object.fromEntries(defs.map((d) => [d.id, fieldKeys(defs).filter((k) => k.field.id === d.id).length]));
    expect(count()).toEqual({ referral: 2, mitoriHome: 1, mitoriFacility: 1, mitoriHospital: 1, jushoji: 1, c002: 2, c0022: 2, excluded: 4, care: 4 });
    expect(fieldKeys()).toHaveLength(18);
    const changed = FIELDS.map((f) => (f.id === "excluded" ? { ...f, axes: ["U-33b" as const] } : f));
    expect(count(changed).excluded).toBe(2);
  });
  it("C-340：どの欄にも「読みで変わらない（同じ数）」の入口がない（鍵は依る軸の読みつきだけ。ほかの鍵は API が断る）", () => {
    expect(fieldKeys().every((k) => k.field.axes.length === 0 || /=[AB]$/.test(k.key))).toBe(true);
    expect(note14WorksheetBody.safeParse({ checkMonth: M, stage1: { months: [], gansou: 0, secondPatient: 0, special: "none", institutions: [] }, stage2: { values: {}, openedOn: null, same: true } }).success).toBe(false);
  });
  it("2 段目の欄が空のままでは結果が出ず、空の欄が名指しされる", () => {
    const e = run(set(base(), "excluded", null, (k) => k.endsWith("U-33b=B")));
    expect(e.status === "incomplete" && e.missing).toEqual(["③ ② のうち除く患者等の数（実人数・算定した月の分だけ）（3 か月）", "③ ② のうち除く患者等の数（月ごとの延べ・算定した月の分だけ）（3 か月）"]);
    expect(evaluate({ stage1: over }, K, P).status).toBe("incomplete");
  });
});

describe("整数の不等式と 4 つ全部での判定（EM R8-199・R8-200）", () => {
  it("4 つ全部を満たす → 基準に当たる。1 つでも満たさない → 基準に当たらない", () => {
    expect(done(run(base())).result).toBe("meets");
    expect(done(run(set(base(), "referral", K.referralMin - 1))).result).toBe("not_meets");
    expect(done(run(set(set(base(), "mitoriHome", 0), "jushoji", K.jushojiMin))).result).toBe("meets");
  });
  it("割合の境（式の両辺がちょうど等しい）で、丸めずに満たす・満たさないが決まる", () => {
    // (②−③)×10 ≦ 7×(①＋②)：①＝30・②＝70・③＝0 で 700 ≦ 700（満たす）、③ を外して ② を 71 にすると 710 ≦ 707（満たさない）
    const r = (c1: number, c2: number, c3: number) => done(run(set(set(set(base(), "c002", c1), "c0022", c2), "excluded", c3))).result;
    expect(r(30, 70, 0)).toBe("meets");
    expect(r(30, 71, 0)).toBe("not_meets");
    // ⑤×2 ≧ ①＋②：⑤＝50・①＋②＝100 で 100 ≧ 100（満たす）、⑤＝49 で満たさない（49.5 % を 50 % に丸めない）
    expect(done(run(set(base(), "care", 50))).result).toBe("meets");
    expect(done(run(set(base(), "care", 49))).result).toBe("not_meets");
  });
});

describe("2 段目の両方の読み（U-31a・U-31b・U-32・U-33a〜c・U-34）", () => {
  const split = (values: Record<string, number | null>, id: string, openedOn: string | null = null) => {
    const e = done(run(values, openedOn));
    expect([e.result, e.splits]).toEqual(["undecided", [id]]);
    expect(e.lines).toHaveLength(1);
    expect(e.lines[0]).toMatch(new RegExp(`^${id}〔.+〕：.+厚生局に確かめてください（照会 #\\d+）$`));
    return e;
  };
  it("X-170（C-322）：患家 0・施設は件数ちょうど・入院経由 0・重症児 0 → U-31a で割れる。患家 12・施設 9 も同じ", () => {
    const e = split(set(set(base(), "mitoriHome", 0), "mitoriFacility", K.mitoriMin), "U-31a");
    expect(e.lines[0]).toBe("U-31a〔施設での看取りを入れるか〕：患家だけなら減算になり、施設も入れると減算になりません。厚生局に確かめてください（照会 #6）");
    split(set(set(base(), "mitoriHome", 12), "mitoriFacility", 9), "U-31a");
  });
  it("U-31b：7 日以内の入院を経た死亡を足すときだけ件数に届く", () => {
    split(set(set(base(), "mitoriHome", K.mitoriMin - 1), "mitoriHospital", 1), "U-31b");
  });
  it("U-32：紹介元の機関の数が狭い・広いで境をまたぐ", () => {
    split(set(base(), "referral", K.referralMin - 1, (k) => k.endsWith("U-32=A")), "U-32");
  });
  it("X-174（C-321）の数：①（実人数 10・延べ 30）、②（実人数 100・延べ 300）、③（実人数・甲 80／実人数・乙 20／延べ・甲 240／延べ・乙 200）で R8-199 が割れる。実人数の①② と延べの③ は組まない", () => {
    const v = base();
    Object.assign(v, { "c002:U-33a=A": 10, "c002:U-33a=B": 30, "c0022:U-33a=A": 100, "c0022:U-33a=B": 300 });
    Object.assign(v, { "excluded:U-33a=A:U-33b=A": 80, "excluded:U-33a=A:U-33b=B": 20, "excluded:U-33a=B:U-33b=A": 240, "excluded:U-33a=B:U-33b=B": 200 });
    Object.assign(v, { "care:U-33a=A:U-33c=A": 110, "care:U-33a=A:U-33c=B": 110, "care:U-33a=B:U-33c=A": 330, "care:U-33a=B:U-33c=B": 330 });
    const e = done(run(v));
    expect(e.result).toBe("undecided");
    expect(e.splits).toEqual(["U-33a", "U-33b"]);
    // 実人数・乙（③＝20）だけが満たさない。実人数の①② に延べの③（200）を当てると満たしてしまうので、当てていないことが分かる
    expect(e.outcomes).toEqual(expect.arrayContaining([{ combo: { "U-33a": "A", "U-33b": "B" }, outcome: "not_meets" }, { combo: { "U-33a": "A", "U-33b": "A" }, outcome: "meets" }, { combo: { "U-33a": "B", "U-33b": "B" }, outcome: "meets" }]));
  });
  it("C-340 の数：①② の実人数 30・70、延べ 40・210、③ 0 で U-33a が割れ、splits に U-33a が残る", () => {
    const v = base();
    Object.assign(v, { "c002:U-33a=A": 30, "c002:U-33a=B": 40, "c0022:U-33a=A": 70, "c0022:U-33a=B": 210 });
    set(v, "excluded", 0);
    Object.assign(v, { "care:U-33a=A:U-33c=A": 100, "care:U-33a=A:U-33c=B": 100, "care:U-33a=B:U-33c=A": 250, "care:U-33a=B:U-33c=B": 250 });
    split(v, "U-33a");
  });
  it("U-33c：⑤ の数え方で境をまたぐ", () => {
    split(set(base(), "care", 49, (k) => k.endsWith("U-33c=B")), "U-33c");
  });
  it("U-34：1 年の期間の途中に開設した施設は、そろわない要件を満たさない読みで減算になり割れる。期間がそろえば割れない", () => {
    const e = split(base(), "U-34", `${P.short.from}-01`.replace(P.short.from, shiftMonth(P.short.from, -1)));
    expect(e.outcomes).toEqual(expect.arrayContaining([{ combo: { "U-34": "B" }, outcome: "not_meets" }]));
    expect(done(run(base(), `${P.long.from}-01`)).result).toBe("meets");
  });
  it("割れない入力では言い切る", () => {
    const e = done(run(base()));
    expect([e.result, e.splits, e.lines]).toEqual(["meets", [], []]);
  });
});
