// 期限を診療年月で比べる（design.md §18-1。判断 A）と、要介護・要支援の認定 careCert（C-510・C-493・C-504）
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { careLevelOf, careStateOf, certifiedOf, effectiveFor, validatePatientFact, type PatientFact, type PatientFactInput } from "../../src/patient/facts";
import { openApp, type App } from "../../src/server/app";
import { claimId, dateIn, day, month, YM } from "../helpers/period";

const row = (f: Partial<PatientFact> & Pick<PatientFact, "key" | "value">, checkedAt = `${day(3)}T09:00:00+09:00`): PatientFact => ({ patientId: "P1", source: "介護保険証", validUntil: null, checkedAt, checkedBy: "new1", ...f });
const cert = (kind: "要介護" | "要支援", level: number, validFrom: string, validUntil: string) => row({ key: "careCert", value: { kind, level, validFrom }, validUntil });

describe("effectiveFor（診療年月の全部の日に効くか）", () => {
  it("終わりが末日以上なら効き、月の中の日・月より前なら効かない。始まりが初日以下なら効き、月の中・月より後なら効かない", () => {
    expect(effectiveFor({ validUntil: null }, YM)).toBe(true);
    expect(effectiveFor({ validUntil: dateIn(0, 31) }, YM)).toBe(true);
    expect(effectiveFor({ validUntil: day(15) }, YM)).toBe(false);
    expect(effectiveFor({ validUntil: dateIn(-1, 30) }, YM)).toBe(false);
    expect(effectiveFor({ validUntil: null, validFrom: day(1) }, YM)).toBe(true);
    expect(effectiveFor({ validUntil: null, validFrom: day(2) }, YM)).toBe(false);
    expect(effectiveFor({ validUntil: null, validFrom: dateIn(1, 1) }, YM)).toBe(false);
  });
});

describe("careStateOf・careLevelOf・certifiedOf", () => {
  it("要介護 3（月の全部の日）は careLevel 3・認定あり。要支援 2 は careLevel 0・認定あり。認定なしは careLevel 0・認定なし", () => {
    const s = careStateOf([cert("要介護", 3, dateIn(-6, 1), dateIn(5, 30))], YM);
    expect([careLevelOf(s, 3), certifiedOf(s)]).toEqual([{ known: true, value: 3 }, { known: true, value: true }]);
    const t = careStateOf([cert("要支援", 2, dateIn(-6, 1), dateIn(5, 30))], YM);
    expect([careLevelOf(t, 3), certifiedOf(t)]).toEqual([{ known: true, value: 0 }, { known: true, value: true }]);
    // 認定なし：確かめた診療月から 6 か月効く（design.md §18-12 の 1）
    const n = careStateOf([row({ key: "careCert", value: { kind: "認定なし", forMonth: YM } }, `${dateIn(1, 10)}T09:00:00+09:00`)], YM);
    expect([careLevelOf(n, 3), certifiedOf(n)]).toEqual([{ known: true, value: 0 }, { known: true, value: false }]);
  });

  it("月の途中で始まる・切れる認定は分からない。分からないの行も分からない", () => {
    expect(careStateOf([cert("要介護", 3, day(10), dateIn(5, 30))], YM)).toEqual({ known: false });
    expect(careStateOf([cert("要介護", 3, dateIn(-6, 1), day(15))], YM)).toEqual({ known: false });
    expect(careStateOf([row({ key: "careCert", value: { kind: "分からない" } })], YM)).toEqual({ known: false });
  });

  it("月の途中で区分が変わった続いた 2 行：要介護 3 以上かが同じなら careLevel は効き、違えば分からない。認定ありかは要介護・要支援で同じなら効く", () => {
    const a = cert("要介護", 3, dateIn(-6, 1), day(15));
    const b = cert("要介護", 4, day(16), dateIn(5, 30));
    const s = careStateOf([a, b], YM);
    expect([careLevelOf(s, 3), certifiedOf(s)]).toEqual([{ known: true, value: 4 }, { known: true, value: true }]);
    const c = cert("要支援", 2, day(16), dateIn(5, 30));
    const t = careStateOf([a, c], YM);
    expect([careLevelOf(t, 3), certifiedOf(t)]).toEqual([{ known: false }, { known: true, value: true }]);
    // 続いていない 2 行（間が空く）は分からない
    expect(careStateOf([a, cert("要介護", 4, day(17), dateIn(5, 30))], YM)).toEqual({ known: false });
  });

  it("今までの careLevel の行：始まりの日を持たず、終わりだけを診療年月で比べる。0 は認定の区分が分からない（R03 は 0 のまま。C-504）", () => {
    const zero = careStateOf([row({ key: "careLevel", value: 0, validUntil: dateIn(3, 31) })], YM);
    expect([careLevelOf(zero, 3), certifiedOf(zero)]).toEqual([{ known: true, value: 0 }, { known: false }]);
    const two = careStateOf([row({ key: "careLevel", value: 2, validUntil: dateIn(3, 31) })], YM);
    expect(certifiedOf(two)).toEqual({ known: true, value: true });
    // careCert の行があれば、そちらだけを読む
    expect(certifiedOf(careStateOf([row({ key: "careLevel", value: 2, validUntil: dateIn(3, 31) }), row({ key: "careCert", value: { kind: "分からない" } })], YM))).toEqual({ known: false });
  });
});

describe("「認定なし（確かめた）」の効く範囲（design.md §18-12 の 1）", () => {
  it("確かめた診療月から 6 か月目まで効き、前の月と 7 か月目には効かない。翌月に確かめても、答えた請求の診療年月に効く", () => {
    const n = [row({ key: "careCert", value: { kind: "認定なし", forMonth: YM } }, `${dateIn(1, 10)}T09:00:00+09:00`)];
    expect([-1, 0, 5, 6].map((m) => certifiedOf(careStateOf(n, month(m))))).toEqual([{ known: false }, { known: true, value: false }, { known: true, value: false }, { known: false }]);
  });
});

describe("入力の検査（validatePatientFact）", () => {
  const now = `${day(13)}T09:00:00+09:00`;
  const v = (f: Omit<PatientFactInput, "source"> & { source?: PatientFactInput["source"] }) => () => validatePatientFact({ source: "介護保険証", ...f }, now);
  it("要介護・要支援は始まりと終わりの日が要り、区分の範囲を確かめる。認定なし・分からないは日付を持たない。終わりが今日より前でも残せる", () => {
    expect(v({ key: "careCert", value: { kind: "要介護", level: 3, validFrom: dateIn(-6, 1) }, validUntil: dateIn(-1, 30) })).not.toThrow();
    expect(v({ key: "careCert", value: { kind: "要介護", level: 6, validFrom: dateIn(-6, 1) }, validUntil: dateIn(5, 30) })).toThrow(/1〜5/);
    expect(v({ key: "careCert", value: { kind: "要支援", level: 3, validFrom: dateIn(-6, 1) }, validUntil: dateIn(5, 30) })).toThrow(/1・2/);
    expect(v({ key: "careCert", value: { kind: "要介護", level: 3 } as never, validUntil: dateIn(5, 30) })).toThrow(/始まり/);
    expect(v({ key: "careCert", value: { kind: "要介護", level: 3, validFrom: dateIn(-6, 1) }, validUntil: null })).toThrow(/終わり/);
    expect(v({ key: "careCert", value: { kind: "要介護", level: 3, validFrom: dateIn(6, 1) }, validUntil: dateIn(5, 30) })).toThrow(/始まりが、終わりより後/);
    expect(v({ key: "careCert", value: { kind: "認定なし" }, validUntil: null })).not.toThrow();
    expect(v({ key: "careCert", value: { kind: "認定なし" }, validUntil: dateIn(5, 30) })).toThrow(/期限は付けない/);
    expect(v({ key: "careCert", value: { kind: "分からない", level: 1 } as never, validUntil: null })).toThrow(/区分と日付を付けない/);
  });
});

describe("請求の判定（design.md §18-9 の 2）", () => {
  let tmp: string;
  let app: App;
  const repo = path.join(__dirname, "..", "..");
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "iji-care-"));
    app = openApp({ root: repo, dbFile: path.join(tmp, "app.db"), knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills"), queryLogDir: path.join(tmp, "query-log") });
    app.upsertClerk({ id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" });
  });
  afterEach(() => {
    app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("翌月の時計で、基準月の請求から「認定なし」を残すと、基準月の請求に効く（確かめた診療月を付ける。design.md §18-12 の 1）", () => {
    app.advanceClock(`${month(1)}-10T09:00:00+09:00`);
    app.savePatientFact(claimId("K4"), "new1", { key: "careCert", value: { kind: "認定なし" }, source: "介護保険証", validUntil: null });
    expect(app.patientFacts(claimId("K4")).facts.find((f) => f.key === "careCert")?.value).toEqual({ kind: "認定なし", forMonth: YM });
    expect(app.caseOf(claimId("K4")).facts.careLevel).toEqual({ known: true, value: 0 });
  });

  it("基準月の請求を翌月の時計で点検して、基準月の末日まで有効の要介護度が効く。15 日まで有効なら分からないになり、情報不足が出る", () => {
    app.advanceClock(`${month(1)}-10T09:00:00+09:00`);
    app.savePatientFact(claimId("K4"), "new1", { key: "careCert", value: { kind: "要介護", level: 2, validFrom: dateIn(-6, 1) }, source: "介護保険証", validUntil: dateIn(0, 31) });
    expect(app.caseOf(claimId("K4")).facts.careLevel).toEqual({ known: true, value: 2 });
    expect(evaluate(app.caseOf(claimId("K4"))).findings).toEqual([]);
    app.savePatientFact(claimId("K4"), "new1", { key: "careCert", value: { kind: "要介護", level: 2, validFrom: dateIn(-6, 1) }, source: "介護保険証", validUntil: day(15) });
    expect(app.caseOf(claimId("K4")).facts.careLevel).toEqual({ known: false });
    expect(evaluate(app.caseOf(claimId("K4"))).findings.map((f) => [f.ruleId, f.kind, f.missing?.field])).toEqual([["R03", "情報不足", "careLevel"]]);
  });
});
