// R20（介護）・R21（ほかの機関）の判定と点検の範囲の文（design.md §18-3・§18-4・§18-6。v37 21c）。エンジンだけで、申告つきの請求の文脈を手で作る
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { residenceOfType, type CareFacts, type OtherFacts, type ShortStayUse } from "../../src/engine/care";
import { CARE_SCOPE_TEXT, careScopeNotes } from "../../src/engine/care-judge";
import { resolveRevision } from "../../src/engine/revisions";
import type { ClaimContext } from "../../src/engine/types";
import { findingText } from "../../src/messages";
import { line, loadCase, withLines } from "./helpers";
import { day, month, YM } from "../helpers/period";

const C = resolveRevision(YM).consts;
const K1 = loadCase("K1");
const b = { checkedOn: day(3), source: "ケアマネジャーからの連絡" as const };
const home = (placedPhysician: "はい" | "いいえ" | "分からない" = "いいえ", mitoriFacility: "はい" | "いいえ" | "分からない" = "いいえ") => ({ kind: "特養（地域密着型を含む）" as const, placedPhysician, mitoriFacility });
type Res = NonNullable<CareFacts["residence"]>["type"];
const res = (type: Res, more: Partial<NonNullable<CareFacts["residence"]>> = {}) => ({ type, changedMidMonth: false, home: null, ...b, ...more });
const cert = { known: true as const, value: true, checkedOn: day(2), source: "介護保険被保険者証" };
/** 訪問診療 2 回（6 日・20 日）と管理料（族を選ぶ） */
const base = (family: "在医総管" | "施設総管", terminal: boolean | null = false): ClaimContext => ({
  ...K1,
  lines: [line("C001_1I", 2, [day(6), day(20)]), line(family === "在医総管" ? "C002_2RO1" : "C002-2_2RO1", 1, [day(20)])],
  facts: { ...K1.facts, table8_2: { known: true, value: false }, residence: { known: true, value: family === "在医総管" ? "居宅" : "施設入居等" }, terminalCancer: terminal === null ? { known: false } : { known: true, value: terminal } },
});
/** 申告を重ねる。住まいの種別があれば、2 値の居住の場所もそこから導く（src/server/app/cases.ts と同じ） */
const withCare = (c: ClaimContext, care: CareFacts): ClaimContext => {
  if (!care.residence) return { ...c, care };
  const r = residenceOfType(care.residence.type);
  return { ...c, care, facts: { ...c.facts, residenceType: { known: true, value: care.residence.type }, residence: r === "居宅" || r === "施設入居等" ? { known: true, value: r } : { known: false } } };
};
const use = (u: Partial<ShortStayUse> & Pick<ShortStayUse, "kind">): ShortStayUse => ({ start: day(18), end: day(24), home: null, fromDischarge: "いいえ", priorVisit: false, ...u });
const stay = (...uses: ShortStayUse[]): CareFacts["shortStay"] => ({ status: "使った", uses, ...b });
const care = (r: Res, more: CareFacts = {}): CareFacts => ({ certified: cert, residence: res(r), ...more });
const of = (c: ClaimContext, ...ids: string[]) => evaluate(c).findings.filter((f) => ids.includes(f.ruleId));
const keys = (c: ClaimContext, ...ids: string[]) => of(c, ...ids).map((f) => (f.kind === "情報不足" ? `${f.ruleId}:${f.missing?.field}` : f.messageKey));
const notes = (c: ClaimContext) => careScopeNotes(c, C);

describe("① 特養の入所者（R8-249・R8-255）", () => {
  it("施設の看取り介護加算の基準が「いいえ」なら、訪問診療料と施医総管で条件つきの指摘 1 件。文は前提から始まり、確かめた日を含む", () => {
    const c = withCare(base("施設総管"), { certified: cert, residence: res("特養（地域密着型を含む）", { home: home() }) });
    const f = of(c, "R20");
    expect(f.map((x) => [x.messageKey, x.lineRefs, x.params?.conditional])).toEqual([["R20.tokuyou", ["C001_1I", "C002-2_2RO1"], "1"]]);
    expect(findingText(f[0])).toMatch(new RegExp(`^申告（特養に入所.*${day(3)} ケアマネジャーからの連絡）のとおりなら、`));
  });
  it("末期の悪性腫瘍なら出ない。施設の基準が「はい」なら出さず「看取りの 30 日」を見ていない。施設の値が分からないなら「見ていません」。末期か分からないなら医師に聞く", () => {
    expect(keys(withCare(base("施設総管", true), { residence: res("特養（地域密着型を含む）", { home: home() }) }), "R20")).toEqual([]);
    const yes = withCare(base("施設総管"), { residence: res("特養（地域密着型を含む）", { home: home("いいえ", "はい") }) });
    expect(keys(yes, "R20")).toEqual([]);
    expect(notes(yes)).toContain(CARE_SCOPE_TEXT.mitori);
    const unknown = withCare(base("施設総管"), { residence: res("特養（地域密着型を含む）") });
    expect(keys(unknown, "R20")).toEqual([]);
    expect(notes(unknown)).toContain(CARE_SCOPE_TEXT.careUnknown);
    expect(keys(withCare(base("施設総管", null), { residence: res("特養（地域密着型を含む）", { home: home() }) }), "R20")).toEqual(["R20.tokuyou", "R20:terminalCancer"]);
  });
});

describe("② 短期入所の月と老健・介護医療院（R8-248・R8-250・R8-251・R8-254・R8-256）", () => {
  it("老健の入所者：訪問診療料・管理料で 1 件。R16 は黙る（2 値に当たらない）", () => {
    const c = withCare({ ...base("在医総管"), facts: { ...base("在医総管").facts, residence: { known: false } } }, care("老健"));
    expect(keys(c, "R20", "R16")).toEqual(["R20.rouken"]);
  });
  it("短期入所生活介護（期間が全部の訪問を含まない）：期間の中の訪問診療料だけを指摘し、管理料は「日ごとに決められない」。R16 は黙る", () => {
    const c = withCare(base("在医総管"), care("自宅", { shortStay: stay(use({ kind: "短期入所生活介護" })) }));
    const f = of(c, "R20", "R16");
    expect(f.map((x) => [x.messageKey, x.days])).toEqual([["R20.seikatsu_prior_visit", [day(20)]]]);
    expect(notes(c)).toContain(CARE_SCOPE_TEXT.stayKanri);
  });
  it("短期入所生活介護（期間が全部の訪問を含む・利用前の訪問なし）：在医総管の族 1 件と訪問診療料 1 件（K26 の形）。施医総管で請求しても逆の向きの指摘は出ない", () => {
    const u = use({ kind: "短期入所生活介護", start: day(5), end: day(24) });
    expect(keys(withCare(base("在医総管"), care("自宅", { shortStay: stay(u) })), "R20", "R16")).toEqual(["R20.seikatsu_family", "R20.seikatsu_prior_visit"]);
    expect(keys(withCare(base("施設総管"), care("自宅", { shortStay: stay(u) })), "R20", "R16")).toEqual(["R20.seikatsu_prior_visit", "R20.seikatsu_prior_kanri"]);
  });
  it("利用前 30 日の当院の訪問が分からないと、それで決まる指摘を出さず「見ていません」。配置医師が「はい」なら算定できない", () => {
    const c = withCare(base("施設総管"), care("自宅", { shortStay: stay(use({ kind: "短期入所生活介護", start: day(5), end: day(24), priorVisit: null })) }));
    expect(keys(c, "R20")).toEqual([]);
    expect(notes(c)).toContain(CARE_SCOPE_TEXT.priorUnknown);
    const h = withCare(base("施設総管"), care("自宅", { shortStay: stay(use({ kind: "短期入所生活介護", start: day(5), end: day(24), priorVisit: true, home: home("はい") })) }));
    expect(keys(h, "R20")).toEqual(["R20.seikatsu_haichi_visit", "R20.seikatsu_haichi_kanri"]);
  });
  it("末期の悪性腫瘍か分からないとき（design.md §18-12 の 2）：短期入所生活介護の指摘は条件つきで出し、前提に「末期の悪性腫瘍でなければ」を足して医師に聞く。宿泊は 30 日の指摘だけ", () => {
    const c = withCare(base("在医総管", null), care("自宅", { shortStay: stay(use({ kind: "短期入所生活介護", start: day(5), end: day(24) })) }));
    expect(keys(c, "R20")).toEqual(["R20.seikatsu_family", "R20.seikatsu_prior_visit", "R20:terminalCancer"]);
    for (const f of of(c, "R20").filter((x) => x.kind !== "情報不足")) expect(findingText(f)).toContain("のとおりなら、末期の悪性腫瘍でなければ");
    const late = withCare(base("在医総管", null), care("自宅", { shortStay: stay(use({ kind: "小多機・看多機の宿泊", start: `${month(-1)}-20`, end: day(30), priorVisit: true })) }));
    expect(keys(late, "R20")).toEqual(["R20.shoutaki_30", "R20:terminalCancer"]);
    // 末期の悪性腫瘍で答えが変わらない指摘（宿泊の族）だけなら、医師に聞かない
    const fam = withCare(base("施設総管", null), care("サ高住（特定施設の指定なし）", { shortStay: stay(use({ kind: "小多機・看多機の宿泊", start: day(5), end: day(24), priorVisit: null })) }));
    expect(keys(fam, "R20")).toEqual(["R20.shoutaki_family"]);
  });
  it("① で末期の悪性腫瘍か分からないときも、前提に「末期の悪性腫瘍でなければ」を足す", () => {
    const f = of(withCare(base("施設総管", null), { residence: res("特養（地域密着型を含む）", { home: home() }) }), "R20")[0];
    expect(findingText(f)).toContain("のとおりなら、末期の悪性腫瘍でなければ");
  });
  it("末期の悪性腫瘍・退院日から始めた短期入所生活介護は判定せず「読みが割れます」と出どころ 2 つ（U-57）", () => {
    const t = withCare(base("施設総管", true), care("自宅", { shortStay: stay(use({ kind: "短期入所生活介護", start: day(5), end: day(24) })) }));
    expect(keys(t, "R20")).toEqual([]);
    expect(notes(t)).toContain(CARE_SCOPE_TEXT.split);
    const d = withCare(base("施設総管"), care("自宅", { shortStay: stay(use({ kind: "短期入所生活介護", start: day(5), end: day(24), fromDischarge: "はい" })) }));
    expect(notes(d)).toContain(CARE_SCOPE_TEXT.split);
  });
  it("小多機の宿泊：2 値が施設入居等の患者が施医総管 → R20 が族 1 件（R16 は黙る）。自宅の患者は R16 が確定で見て、R20 は族を重ねない（C-501）", () => {
    const u = use({ kind: "小多機・看多機の宿泊", start: day(5), end: day(24), priorVisit: null });
    expect(keys(withCare(base("施設総管"), care("サ高住（特定施設の指定なし）", { shortStay: stay(u) })), "R20", "R16")).toEqual(["R20.shoutaki_family"]);
    expect(keys(withCare(base("施設総管"), care("自宅", { shortStay: stay(u) })), "R20", "R16")).toEqual(["R16.use_zaii"]);
    expect(keys(withCare(base("在医総管"), care("自宅", { shortStay: stay(u) })), "R20", "R16")).toEqual([]);
  });
  it("小多機の宿泊で退院日から始めたか分からず、利用前の訪問がない：指摘を出さず「見ていません」。いいえなら条件つき（X-353・X-364）", () => {
    const u = (fromDischarge: "分からない" | "いいえ" | "はい") => use({ kind: "小多機・看多機の宿泊", start: day(5), end: day(24), fromDischarge });
    expect(keys(withCare(base("在医総管"), care("自宅", { shortStay: stay(u("分からない")) })), "R20")).toEqual([]);
    expect(keys(withCare(base("在医総管"), care("自宅", { shortStay: stay(u("いいえ")) })), "R20")).toEqual(["R20.shoutaki_prior_visit", "R20.shoutaki_prior_kanri"]);
    expect(keys(withCare(base("在医総管"), care("自宅", { shortStay: stay(u("はい")) })), "R20")).toEqual([]);
  });
  it("2 回以上の利用で日付のないものがあれば判定しない（X-362）。使っていないと確かめた月は何も出さない", () => {
    const two = withCare(base("施設総管"), care("自宅", { shortStay: stay(use({ kind: "短期入所生活介護", start: null }), use({ kind: "短期入所生活介護", start: day(25), end: day(27) })) }));
    expect(keys(two, "R20")).toEqual([]);
    expect(notes(two)).toContain(CARE_SCOPE_TEXT.careUnknown);
    expect(keys(withCare(base("在医総管"), care("自宅", { shortStay: { status: "使っていない", uses: [], ...b } })), "R20", "R16")).toEqual([]);
  });
  it("月の途中で住まいが変わった月：R20 は判定せず、R16 も黙る。文が出る", () => {
    const c = withCare(base("施設総管"), { certified: cert, residence: res("自宅", { changedMidMonth: true }) });
    expect(keys(c, "R20", "R16")).toEqual([]);
    expect(notes(c)).toContain(CARE_SCOPE_TEXT.midMonth);
  });
});

describe("④ 要介護・要支援の患者の在宅患者連携指導料（R8-265）", () => {
  it("認定があれば条件つき 1 件。認定なしと確かめていれば出ない。分からなければ「見ていません」", () => {
    const c = withLines(base("在医総管"), line("C010", 1, [day(6)]));
    expect(keys(withCare(c, care("自宅", { shortStay: { status: "使っていない", uses: [], ...b } })), "R20")).toEqual(["R20.renkei"]);
    expect(keys(withCare(c, { certified: { ...cert, value: false }, residence: res("自宅") }), "R20")).toEqual([]);
    const u = withCare(c, { certified: { known: false }, residence: res("自宅"), shortStay: { status: "使っていない", uses: [], ...b } });
    expect(keys(u, "R20")).toEqual([]);
    expect(notes(u)).toContain(CARE_SCOPE_TEXT.careUnknown);
  });
});

describe("R21 ほかの機関（R8-270・R8-274・R8-275・R8-284）", () => {
  const row = (r: Partial<OtherFacts["rows"][number]>): OtherFacts["rows"][number] => ({ kind: "医療機関", specialRelation: "いいえ", kanriSide: "取っていない", activities: {}, referredOn: null, ...b, ...r });
  it("⑤ ほかの機関が在医総管を取る → 条件つき 1 件。分からない → 「見ていません」。ないと確かめた → 何も出さない。申告がない → 「見ていません」", () => {
    expect(keys({ ...base("在医総管"), others: { rows: [row({ kanriSide: "その機関" })], none: null } }, "R21")).toEqual(["R21.kanri_one"]);
    const u = { ...base("在医総管"), others: { rows: [row({ kanriSide: "分からない" })], none: null } };
    expect([keys(u, "R21"), notes(u).includes(CARE_SCOPE_TEXT.othersUnknown)]).toEqual([[], true]);
    const none = { ...base("在医総管"), others: { rows: [], none: b } };
    expect([keys(none, "R21"), notes(none).includes(CARE_SCOPE_TEXT.othersUnknown)]).toEqual([[], false]);
    expect(notes(base("在医総管"))).toContain(CARE_SCOPE_TEXT.othersUnknown);
  });
  it("⑥ 求めた日の月を 1 か月目として 7 か月目以降 → 条件つき 1 件。6 か月目は出ない。求めた側の申告がなければ（ないと確かめた月も）「求めた機関の申告がありません」", () => {
    const c = withLines({ ...K1, lines: [] }, line("C001_2I", 1, [day(6)]));
    const req = (m: number) => ({ ...c, others: { rows: [row({ activities: { 求めによる訪問診療の求めた側: "はい" }, referredOn: `${month(m)}-10` })], none: null } });
    expect(keys(req(-6), "R21")).toEqual(["R21.visit2_6m"]);
    expect(keys(req(-5), "R21")).toEqual([]);
    expect(findingText(of(req(-6), "R21")[0])).toContain("摘要欄に継続の理由・疾病等の記載がなければ");
    expect(notes({ ...c, others: { rows: [], none: b } })).toContain(CARE_SCOPE_TEXT.noReferrer);
  });
  it("⑦ 特別の関係の医療機関が訪問看護をした月の C007 → 条件つき 1 件。ステーションの訪問看護の月は当たらない。特別の関係が分からないなら「見ていません」", () => {
    const c = withLines(base("在医総管"), line("C007", 1, [day(6)]));
    expect(keys({ ...c, others: { rows: [row({ specialRelation: "はい", activities: { 医療機関が行う訪問看護: "はい" } })], none: null } }, "R21")).toEqual(["R21.shiji"]);
    expect(keys({ ...c, others: { rows: [row({ kind: "訪問看護ステーション", specialRelation: "はい", activities: { "ステーションの訪問看護（医療保険）": "はい" } })], none: null } }, "R21")).toEqual([]);
    const u = { ...c, others: { rows: [row({ specialRelation: "分からない", activities: { 医療機関が行う訪問看護: "はい" } })], none: null } };
    expect([keys(u, "R21"), notes(u).includes(CARE_SCOPE_TEXT.othersUnknown)]).toEqual([[], true]);
  });
});

describe("点検の範囲の文", () => {
  it("場面の区分の行がある請求だけ。先頭は「最初の版で見ている場面」", () => {
    expect(notes({ ...K1, lines: [line("D400_1", 1, [day(6)])] })).toEqual([]);
    expect(notes(base("在医総管"))[0]).toBe(CARE_SCOPE_TEXT.scenes);
  });
  it("確かめた日が診療年月の末日より 6 か月以上前なら、前提の文に足す", () => {
    const c = withCare(base("施設総管"), { residence: { ...res("特養（地域密着型を含む）", { home: home() }), staleMonths: 6 } });
    expect(findingText(of(c, "R20")[0])).toContain("確かめてから 6 か月を過ぎています");
  });
});
