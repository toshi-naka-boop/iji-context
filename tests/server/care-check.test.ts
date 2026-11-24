// 聞き取りの画面（design.md §18-5。v37 21d）の一覧と、医師に確かめる事実 terminalCancer（判断 H）。AI は呼ばない
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/server/app";
import { fileOf, receiptOf, tempApp, upload } from "../helpers/care";
import { day, YM } from "../helpers/period";

let app: App;
let close: () => void;
beforeEach(() => ({ app, close } = tempApp()));
afterEach(() => close());

const b = { checkedOn: day(3), source: "ケアマネジャーからの連絡" as const };
const zaii = [{ kubun: "C001_1I", count: 2, dates: [day(6), day(20)] }, { kubun: "C002_2RO1", count: 1, dates: [day(20)] }];
const target = (id: string) => app.careCheck(YM).targets.find((t) => t.claimId === id);

describe("聞き取りの画面の一覧", () => {
  it("場面の区分の行がある請求だけ。要る問いだけを聞き、答えると問いが減り、「見ていません」も消える", () => {
    const [id, plain] = upload(app, fileOf([receiptOf(1, YM, zaii), receiptOf(2, YM, [{ kubun: "D400_1", count: 1, dates: [day(6)] }])]));
    expect(target(plain)).toBeUndefined();
    expect(target(id)).toMatchObject({ asks: ["careCert", "residenceType", "shortStay", "others"], notDone: true });
    // 月の一覧の数は、同梱の見本の請求も含めて数え、月の画面の一覧と同じ数
    expect(app.careCheck().months.find((m) => m.month === YM)?.targets).toBe(app.careCheck(YM).targets.length);
    app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "要介護", level: 3, validFrom: `${YM.slice(0, 4)}-01-01` }, source: "介護保険証", validUntil: `${Number(YM.slice(0, 4)) + 1}-12-31` });
    app.saveCare(id, "new1", { item: "residenceType", value: { type: "自宅" }, ...b });
    expect(target(id)?.asks).toEqual(["shortStay", "others"]);
    app.saveCare(id, "new1", { item: "shortStay", value: { status: "使っていない" }, ...b });
    app.saveOtherNone(id, "new1", b);
    expect(target(id)).toBeUndefined();
    expect(app.careCheck(YM).targets.some((t) => t.claimId === id)).toBe(false);
  });

  it("認定がないと確かめた患者と、施設の入所者には、短期入所を聞かない（C-493）", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii)]));
    app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "認定なし" }, source: "介護保険証", validUntil: null });
    // 施設（特養）の入所者には聞かない
    app.saveCare(id, "new1", { item: "residenceType", value: { type: "特養（地域密着型を含む）" }, ...b });
    expect(target(id)?.asks).not.toContain("shortStay");
  });
});

describe("医師に確かめる事実 terminalCancer（判断 H。FR-174）", () => {
  it("特養の入所者で施設の基準が「いいえ」の月に、医師あての項目に「末期の悪性腫瘍か」が出る。選択肢に「その他」「判定不能」。医師が残すと事実になる", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, [{ kubun: "C001_1I", count: 2, dates: [day(6), day(20)] }, { kubun: "C002-2_2RO1", count: 1, dates: [day(20)] }])]));
    const homes = app.saveCareHome("new1", { name: "架空の特養", kind: "特養（地域密着型を含む）", placedPhysician: "いいえ", mitoriFacility: "いいえ", recheckOn: day(31), ...b, source: "施設との契約" });
    app.saveCare(id, "new1", { item: "residenceType", value: { type: "特養（地域密着型を含む）", careHomeId: homes[0].homeId }, ...b });
    const item = app.doctorFacts().find((i) => i.claimId === id && i.field === "terminalCancer");
    expect(item).toMatchObject({ scope: "patient", input: "boolean", question: "末期の悪性腫瘍か" });
    expect(item!.options).toEqual(["はい", "いいえ", "その他", "判定不能"]);
    app.upsertClerk({ id: "doc1", name: "医師", callName: "先生", characterId: "a", role: "clerk" });
    app.savePatientFact(id, "doc1", { key: "terminalCancer", value: true, source: "医師に確認", validUntil: null }, "doctor");
    expect(app.caseOf(id).facts.terminalCancer).toEqual({ known: true, value: true });
    expect(app.doctorFacts().some((i) => i.claimId === id && i.field === "terminalCancer")).toBe(false);
  });
});
