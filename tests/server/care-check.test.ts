// 聞き取りの画面（design.md §18-5。v37 21d）の一覧と、医師に確かめる事実 terminalCancer（判断 H）。AI は呼ばない
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { monthRange } from "../../src/demo/period";
import type { App } from "../../src/server/app";
import { fileOf, receiptOf, tempApp, upload } from "../helpers/care";
import { day, month, YM } from "../helpers/period";

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

describe("期限が近いだけの患者（design.md §18-12 の 5）", () => {
  it("認定が診療年月の全部の日に効いていれば、期限が近くても聞き取りの対象にしない（期限の知らせは患者の画面の P07）", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii)]));
    // 時計（基準月の 13 日）から 30 日以内に切れるが、基準月の末日までは効く
    app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "要介護", level: 3, validFrom: `${YM}-01` }, source: "介護保険証", validUntil: monthRange(YM).end });
    expect(target(id)?.asks).not.toContain("careCert");
    expect(app.patientProfile(id).findings.map((f) => f.messageKey)).toContain("P07.expiring_soon");
  });
});

describe("確かめた日の初期値（design.md §18-12 の 7）", () => {
  it("聞き取りの画面は、確かめた日の初期値にクリニックの今日（GET /api/clock）を使い、端末の日付を使わない", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.join(__dirname, "..", "..", "app", "uke", "care-check", "page.tsx"), "utf8");
    expect(src).toContain('"/api/clock"');
    expect(src).not.toMatch(/new Date\(/);
  });
});

describe("判定に要る項目の「分からない」「欠け」も聞く（round-82 C-541・X-391）", () => {
  const b2 = { checkedOn: day(3), source: "施設との契約" as const };
  it("特養で入所先の施設を付けていない・在医総管を取る側が分からない・(Ⅰ)2 の月に求めた機関がない・短期入所の日付が欠けている患者も、その問いを出す。「見ていません」の患者はみな画面に出る", () => {
    const shisetsu = [{ kubun: "C001_1I", count: 2, dates: [day(6), day(20)] }, { kubun: "C002-2_2RO1", count: 1, dates: [day(20)] }];
    const [a, bId, cId, dId] = upload(app, fileOf([receiptOf(1, YM, shisetsu), receiptOf(2, YM, zaii), receiptOf(3, YM, [{ kubun: "C001_2I", count: 1, dates: [day(9)] }]), receiptOf(4, YM, zaii)]));
    const cert = (id: string) => app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "要介護", level: 3, validFrom: `${YM}-01` }, source: "介護保険証", validUntil: `${month(5)}-01` });
    for (const id of [a, bId, cId, dId]) cert(id);
    // (a) 特養で施設を付けていない
    app.saveCare(a, "new1", { item: "residenceType", value: { type: "特養（地域密着型を含む）" }, ...b });
    app.saveOtherNone(a, "new1", b);
    expect(target(a)?.asks).toEqual(["residenceType"]);
    // (b) 在医総管を取る側が分からない
    app.saveCare(bId, "new1", { item: "residenceType", value: { type: "自宅" }, ...b });
    app.saveCare(bId, "new1", { item: "shortStay", value: { status: "使っていない" }, ...b });
    app.saveOther(bId, "new1", { name: "架空の診療所", kind: "医療機関", specialRelation: "いいえ", kanriSide: "分からない", activities: {}, ...b });
    expect(target(bId)?.asks).toEqual(["others"]);
    // (c) (Ⅰ)2 の月に「ないと確かめた」だけ
    app.saveCare(cId, "new1", { item: "residenceType", value: { type: "自宅" }, ...b });
    app.saveCare(cId, "new1", { item: "shortStay", value: { status: "使っていない" }, ...b });
    app.saveOtherNone(cId, "new1", b);
    expect(target(cId)?.asks).toEqual(["others"]);
    // (d) 同じ月に 2 回の短期入所で日付が欠けている
    app.saveCare(dId, "new1", { item: "residenceType", value: { type: "自宅" }, ...b });
    app.saveOtherNone(dId, "new1", b);
    app.saveCare(dId, "new1", { item: "shortStay", value: { status: "使った", uses: [{ kind: "短期入所生活介護" }, { kind: "短期入所生活介護", start: day(25), end: day(27) }] }, ...b2 });
    expect(target(dId)?.asks).toEqual(["shortStay"]);
    // 「見ていません」の人数は、画面に出る人数に入る
    const all = app.careCheck(YM);
    const m = app.careCheck().months.find((x) => x.month === YM)!;
    expect(m.targets).toBe(all.targets.length);
    expect(all.targets.filter((t) => t.notDone).length).toBe(m.notDone);
  });
});

describe("申請中は要介護認定の期限の知らせ（P07）に出さない（round-82 C-542）", () => {
  it("申請中を残しても P07.missing は出ない", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii)]));
    app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "申請中" }, source: "介護保険証", validUntil: null });
    expect(app.patientProfile(id).findings.filter((f) => f.checkId === "P07")).toEqual([]);
  });
});
