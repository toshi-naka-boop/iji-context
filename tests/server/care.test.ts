// 介護保険・ほかの医療機関との調整の申告（design.md §18-2。v37 21b）：入れ物（マイグレーション 21・22）、入力の検査、診療年月に効く行の選び方、
// 2 値の居住の場所の導き方（R16・導出 D03）。AI は呼ばない
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { deriveLines } from "../../src/engine/derive";
import type { App } from "../../src/server/app";
import { fileOf, receiptOf, tempApp, upload } from "../helpers/care";
import { day, month, YM } from "../helpers/period";

let app: App;
let close: () => void;
beforeEach(() => ({ app, close } = tempApp()));
afterEach(() => close());

const basis = { checkedOn: day(3), source: "ケアマネジャーからの連絡" as const };
/** 訪問診療 2 回と在医総管（2ロ）の請求 */
const zaii = (ym = YM) => [{ kubun: "C001_1I", count: 2, dates: [`${ym}-06`, `${ym}-20`] }, { kubun: "C002_2RO1", count: 1, dates: [`${ym}-20`] }];
const r16 = (id: string) => evaluate(app.caseOf(id)).findings.filter((f) => f.ruleId === "R16").map((f) => [f.kind, f.messageKey, f.missing?.field]);

describe("入力の検査", () => {
  it("住まいの種別・短期入所・訪問看護の保険の値、施設、確かめた日・出どころを確かめる", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii())]));
    expect(() => app.saveCare(id, "new1", { item: "residenceType", value: { type: "宇宙" as never }, ...basis })).toThrow(/住まいの種別/);
    expect(() => app.saveCare(id, "new1", { item: "residenceType", value: { type: "特養（地域密着型を含む）", careHomeId: "H00000000" }, ...basis })).toThrow(/その施設はありません/);
    expect(() => app.saveCare(id, "new1", { item: "residenceType", value: { type: "自宅" }, checkedOn: "10/3", source: "その他" })).toThrow(/確かめた日/);
    expect(() => app.saveCare(id, "new1", { item: "shortStay", value: { status: "使った" }, ...basis })).toThrow(/1 つ以上/);
    expect(() => app.saveCare(id, "new1", { item: "shortStay", value: { status: "使っていない", uses: [{ kind: "短期入所生活介護" }] }, ...basis })).toThrow(/付けません/);
    expect(() => app.saveCare(id, "new1", { item: "shortStay", value: { status: "使った", uses: [{ kind: "短期入所生活介護", start: day(20), end: month(1) + "-02" }] }, ...basis })).toThrow(/この月の中/);
    expect(() => app.saveCare(id, "new1", { item: "shortStay", value: { status: "使った", uses: [{ kind: "短期入所生活介護", start: day(24), end: day(20) }] }, ...basis })).toThrow(/開始日が、終了日より後/);
    // 月をまたぐ利用は、開始日を前の月の日で入れてよい
    expect(() => app.saveCare(id, "new1", { item: "shortStay", value: { status: "使った", uses: [{ kind: "短期入所生活介護", start: `${month(-1)}-28`, end: day(3) }] }, ...basis })).not.toThrow();
    expect(() => app.saveCare(id, "new1", { item: "nurseInsurance", value: { value: "介護保険" }, ...basis })).not.toThrow();
    expect(() => app.saveCareHome("new1", { name: "", kind: "特養（地域密着型を含む）", placedPhysician: "いいえ", mitoriFacility: "いいえ", checkedOn: day(3), recheckOn: day(2), source: "施設との契約" })).toThrow(/名前/);
    expect(() => app.saveCareHome("new1", { name: "架空の特養", kind: "特養（地域密着型を含む）", placedPhysician: "いいえ", mitoriFacility: "いいえ", checkedOn: day(3), recheckOn: day(2), source: "施設との契約" })).toThrow(/確かめ直す日/);
    expect(() => app.saveOther(id, "new1", { name: "架空の医院", kind: "医療機関", specialRelation: "いいえ", kanriSide: "その機関", activities: { 訪問診療: "ある" as never }, ...basis })).toThrow(/していること/);
    expect(() => app.saveCare(id, "nobody", { item: "residenceType", value: { type: "自宅" }, ...basis })).toThrow(/登録されていない/);
  });
});

describe("診療年月に効く行の選び方", () => {
  it("住まいの種別は fromMonth（答えた請求の診療年月）で選び、次の月に引き継ぐ。短期入所はその月だけ", () => {
    const [a, b] = upload(app, fileOf([receiptOf(1, YM, zaii()), receiptOf(1, month(1), zaii(month(1)))]));
    app.saveCare(a, "new1", { item: "residenceType", value: { type: "自宅" }, ...basis });
    app.saveCare(a, "new1", { item: "shortStay", value: { status: "使っていない" }, ...basis });
    expect(app.careView(a).care.residenceType?.fromMonth).toBe(YM);
    expect(app.careView(b).care.residenceType?.value).toEqual({ type: "自宅" });
    expect(app.careView(b).care.shortStay).toBeUndefined();
    // 次の月から有料老人ホーム：次の月だけ変わる
    app.saveCare(b, "new1", { item: "residenceType", value: { type: "有料老人ホーム（特定施設の指定なし）" }, ...basis });
    expect([app.caseOf(a).facts.residence, app.caseOf(b).facts.residence]).toEqual([{ known: true, value: "居宅" }, { known: true, value: "施設入居等" }]);
  });

  it("ほかの機関は機関ごとに fromMonth で選び、endMonth を過ぎたら効かない。「ないと確かめた」は確かめた診療月から 6 か月で、前の月には効かない（X-354）", () => {
    const ids = upload(app, fileOf([-1, 0, 1, 5, 6].map((m) => receiptOf(1, month(m), zaii(month(m))))));
    const [prev, cur, next, m5, m6] = ids;
    app.saveOther(cur, "new1", { name: "架空の医院", kind: "医療機関", specialRelation: "いいえ", kanriSide: "その機関", activities: { 訪問診療: "はい" }, endMonth: month(1), ...basis });
    expect([prev, cur, next, m5].map((id) => app.careView(id).others.length)).toEqual([0, 1, 1, 0]);
    app.saveOtherNone(cur, "new1", basis);
    expect([prev, cur, next, m5, m6].map((id) => app.careView(id).none !== null)).toEqual([false, true, true, true, false]);
  });
});

describe("2 値の居住の場所の導き方（R16・導出 D03。design.md §18-2）", () => {
  it("自宅は居宅、特養は施設入居等で R16 が今までどおり見る。老健・介護医療院・養護（それ以外）は R16 が情報不足を出さず何も言わない", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii())]));
    app.saveCare(id, "new1", { item: "residenceType", value: { type: "自宅" }, ...basis });
    expect(r16(id)).toEqual([]);
    app.saveCare(id, "new1", { item: "residenceType", value: { type: "特養（地域密着型を含む）" }, ...basis });
    expect(r16(id)).toEqual([["区分誤り", "R16.use_shisetsu", undefined]]);
    for (const type of ["老健", "介護医療院", "養護老人ホーム（それ以外）"] as const) {
      app.saveCare(id, "new1", { item: "residenceType", value: { type }, ...basis });
      expect([type, r16(id)]).toEqual([type, []]);
    }
  });

  it("分からないと、聞くのは住まいの種別（C-494）。申告がなければ今までの 2 値の行を使う", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii())]));
    expect(r16(id)).toEqual([["情報不足", "R16.missing_fact", "residenceType"]]);
    app.savePatientFact(id, "new1", { key: "residence", value: "居宅", source: "カルテ", validUntil: null });
    expect(r16(id)).toEqual([]);
    app.saveCare(id, "new1", { item: "residenceType", value: { type: "分からない" }, ...basis });
    expect(r16(id)).toEqual([["情報不足", "R16.missing_fact", "residenceType"]]);
    expect(app.careView(id).legacyResidence).toBeNull();
  });

  it("導出 D03：2 値に当たらない月は管理料の行を立てず、族を決められない理由つきで保留にし、居住の場所を聞かない（C-500）", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii())]));
    app.saveCare(id, "new1", { item: "residenceType", value: { type: "老健" }, ...basis });
    const ctx = { ...app.caseOf(id), facts: { ...app.caseOf(id).facts, comprehensiveCare: { known: true as const, value: true } } };
    const d = deriveLines({ yearMonth: ctx.yearMonth, facility: ctx.facility, facts: ctx.facts, care: ctx.care, events: [{ type: "visit", date: day(6), sameBuildingCount: 1 }, { type: "visit", date: day(20), sameBuildingCount: 1 }], manual: [], choices: {} });
    expect(d.pending.filter((p) => p.kind === "事実不足" && p.id.startsWith("D03-residence")).map((p) => p.kind === "事実不足" && [p.need, p.reason])).toEqual([["residenceType", "care_family"]]);
  });
});
