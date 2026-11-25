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

describe("?claim= で開く（round-82 C-543）", () => {
  it("請求を名指しすると、その請求の診療年月の一覧を返す（ほかの月を先に取り込んでいても）", () => {
    const [, next] = upload(app, fileOf([receiptOf(1, month(-1), zaii.map((l) => ({ ...l, dates: l.dates.map((d) => d.replace(YM, month(-1))) }))), receiptOf(1, YM, zaii)]));
    const r = app.careCheck(undefined, next);
    expect(r.month).toBe(YM);
    expect(r.targets.some((t) => t.claimId === next)).toBe(true);
  });
});

describe("ほかの機関の問いは、その請求の場面で読む項目の「分からない」だけで決める（round-83 X-403）", () => {
  it("管理料の請求で取る側が「当院」と分かっていれば、使わない項目（在がん総診など）が分からなくても聞かない", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii)]));
    app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "要介護", level: 3, validFrom: `${YM}-01` }, source: "介護保険証", validUntil: `${month(5)}-01` });
    app.saveCare(id, "new1", { item: "residenceType", value: { type: "自宅" }, ...b });
    app.saveCare(id, "new1", { item: "shortStay", value: { status: "使っていない" }, ...b });
    app.saveOther(id, "new1", { name: "架空の診療所", kind: "医療機関", specialRelation: "分からない", kanriSide: "当院", activities: { 在がん総診: "分からない" }, ...b });
    expect(target(id)).toBeUndefined();
  });
});

describe("今ある機関の行を、聞き取りの画面から直す（round-83 X-402）", () => {
  it("在医総管を取る側が「分からない」の行を、同じ機関（instId）で「当院」に答え直すと、問いと「見ていません」が消える", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii)]));
    app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "要介護", level: 3, validFrom: `${YM}-01` }, source: "介護保険証", validUntil: `${month(5)}-01` });
    app.saveCare(id, "new1", { item: "residenceType", value: { type: "自宅" }, ...b });
    app.saveCare(id, "new1", { item: "shortStay", value: { status: "使っていない" }, ...b });
    const { instId } = app.saveOther(id, "new1", { name: "架空の診療所", kind: "医療機関", specialRelation: "いいえ", kanriSide: "分からない", activities: {}, ...b });
    expect(target(id)).toMatchObject({ asks: ["others"], notDone: true });
    // 画面は careView の行（instId つき）から、その機関を選んで直す
    expect(app.careView(id).others.map((o) => o.instId)).toEqual([instId]);
    app.saveOther(id, "new1", { instId, name: "架空の診療所", kind: "医療機関", specialRelation: "いいえ", kanriSide: "当院", activities: {}, ...b });
    expect(app.careView(id).others).toHaveLength(1);
    expect(target(id)).toBeUndefined();
  });
  it("聞き取りの画面のほかの機関の入力は、今ある機関を選ぶと instId を送って同じ行を直す", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.join(__dirname, "..", "..", "app", "uke", "care-check", "page.tsx"), "utf8");
    expect(src).toContain('aria-label="直す機関"');
    expect(src).toContain("...(instId ? { instId } : {})");
  });
});

describe("機関の訂正で、今ある値を落とさない（round-84 X-412）", () => {
  it("終わった月のある機関で特別の関係だけを直しても、終わった月・求めた日・していることは今の値のまま", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii)]));
    const { instId } = app.saveOther(id, "new1", { name: "架空の病院", kind: "医療機関", specialRelation: "分からない", kanriSide: "取っていない", activities: { 医療機関が行う訪問看護: "はい" }, referredOn: day(2), endMonth: month(1), ...b });
    app.saveOther(id, "new1", { instId, name: "架空の病院", kind: "医療機関", specialRelation: "はい", kanriSide: "取っていない", activities: {}, ...b });
    const rows = app.careView(id).others;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ specialRelation: "はい", endMonth: month(1), referredOn: day(2), activities: { 医療機関が行う訪問看護: "はい" } });
  });
});

describe("機関の訂正で引き継ぐ値は、訂正する月に効いていた行から取る（X-422）", () => {
  it("10 月に終わり 11 月で残す → 1 月に終わり 2 月で残す → 10 月分を訂正：10 月の行の終わりは 11 月のままで、12 月に効く機関はない", () => {
    const [oct, jan] = upload(app, fileOf([receiptOf(1, YM, zaii), receiptOf(1, month(3), zaii.map((l) => ({ ...l, dates: l.dates.map((d) => d.replace(YM, month(3))) })))]));
    const { instId } = app.saveOther(oct, "new1", { name: "架空の病院", kind: "医療機関", specialRelation: "分からない", kanriSide: "取っていない", activities: {}, endMonth: month(1), ...b });
    app.saveOther(jan, "new1", { instId, name: "架空の病院", kind: "医療機関", specialRelation: "いいえ", kanriSide: "取っていない", activities: {}, endMonth: month(4), ...b });
    app.saveOther(oct, "new1", { instId, name: "架空の病院", kind: "医療機関", specialRelation: "はい", kanriSide: "取っていない", activities: {}, ...b });
    expect(app.careView(oct).others[0]).toMatchObject({ specialRelation: "はい", endMonth: month(1) });
    const dec = upload(app, fileOf([receiptOf(1, month(2), zaii.map((l) => ({ ...l, dates: l.dates.map((d) => d.replace(YM, month(2))) })))])).at(-1)!;
    expect(app.careView(dec).yearMonth).toBe(month(2));
    expect(app.careView(dec).others).toEqual([]);
  });
});

describe("申請中が残る月は聞き取りの対象（EM U-71 の v40・v41 の書き足し）", () => {
  it("申請中を残した月は、認定を聞く", () => {
    const [id] = upload(app, fileOf([receiptOf(1, YM, zaii)]));
    app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "申請中" }, source: "介護保険証", validUntil: null });
    expect(target(id)?.asks).toContain("careCert");
  });
});
