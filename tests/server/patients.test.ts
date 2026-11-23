// 患者マスタへの取り込み（src/server/app/patients.ts）。UKE の中身は差し替えられるよう、UKE の読み込みだけを偽物にして組み立てる
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureConnector } from "../../src/connect/fixture";
import { APP_MIGRATIONS, migrate } from "../../src/db/migrate";
import { evaluate } from "../../src/engine";
import type { ClaimContext } from "../../src/engine/types";
import { openApp } from "../../src/server/app";
import { createClerks } from "../../src/server/app/clerks";
import { createClock } from "../../src/server/app/clock";
import { json, openContext } from "../../src/server/app/context";
import { createPatients } from "../../src/server/app/patients";
import type { PatientRecord } from "../../src/patient/profile";
import type { Uke } from "../../src/server/app/uke";
import type { UkeFile, UkePatient } from "../../src/uke/types";
import { claimId, dateIn, day, month } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-patients-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const paths = () => ({ root: repo, dbFile: path.join(tmp, "app.db"), knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills"), queryLogDir: path.join(tmp, "query-log") });

/** 架空の患者（番号の検証番号は合わせてある） */
const person = (over: Partial<UkePatient> = {}): UkePatient => ({ name: "架空　七郎", sex: 1, birth: "19540401", receiptType: "1118", insurer: { number: "01139997", symbol: "1", no: "00000007" }, kohi: [], diseases: [], ...over });
const file = (receipts: [string, UkePatient][]): UkeFile => ({
  payer: "国保連",
  prefecture: "東京都",
  clinic: { code: "9999999", name: "架空在宅クリニック", phone: "0300000000" },
  billingMonth: month(1),
  receipts: receipts.map(([claimId, patient]) => ({ claimId, yearMonth: claimId.slice(-7), patient, lines: [{ kubun: "C001_1I", count: 1, dates: [`${claimId.slice(-7)}-05`] }], comments: [], commentsKnown: true })),
});

function setup(files: () => UkeFile[]) {
  const ctx = openContext(paths());
  const clock = createClock(ctx);
  const clerks = createClerks(ctx);
  clerks.upsertClerk({ id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" });
  const patients = createPatients(ctx, clock, clerks, { ukeFiles: files } as unknown as Uke);
  return { ctx, clock, patients };
}
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("患者マスタへの取り込み", () => {
  it("同じ UKE を何度読んでも、患者も加入情報も増えない", () => {
    const p = person({ kohi: [{ payerNo: "54139993", recipientNo: "9999996" }] });
    const { ctx, patients } = setup(() => [file([[claimId("K17"), p]])]);
    const first = patients.patientProfile(claimId("K17"));
    patients.patientProfile(claimId("K17"));
    patients.patientFacts(claimId("K17"));
    expect(count(ctx.sqlite, "patients")).toBe(1);
    expect(count(ctx.sqlite, "patient_coverages")).toBe(2);
    expect(first.patientId).toBe("P0001");
    expect(first.coverages.map((c) => [c.kind, c.position, c.payerNumber, c.memberNo, c.source])).toEqual([["医保", 0, "01139997", "00000007", "UKE"], ["公費", 1, "54139993", "9999996", "UKE"]]);
    ctx.sqlite.close();
  });

  it("保険が変わっても同じ人として続き、確かめた患者情報は同じ患者に付いたままになる", () => {
    let current = file([[claimId("K17"), person()]]);
    const { ctx, patients } = setup(() => [current]);
    patients.savePatientFact(claimId("K17"), "new1", { key: "careLevel", value: 3, source: "介護保険証", validUntil: dateIn(9, 31) });
    const before = patients.patientFacts(claimId("K17"));

    // 翌月、後期高齢者医療に変わった（氏名の空白の違いは同じ人として扱う）
    current = file([[`K17-${month(1)}`, person({ name: "架空 七郎", receiptType: "1318", insurer: { number: "39139993", symbol: "", no: "00000077" } })]]);
    const after = patients.patientFacts(`K17-${month(1)}`);
    expect(after.patientId).toBe(before.patientId);
    expect(after.facts).toEqual([expect.objectContaining({ key: "careLevel", value: 3, checkedBy: "new1" })]);
    expect(count(ctx.sqlite, "patients")).toBe(1);
    // 加入情報は 2 件になり、期限が分からないあいだは、どちらが有効かを確かめるよう指摘が出る
    const prof = patients.patientProfile(`K17-${month(1)}`);
    expect(prof.coverages.map((c) => c.payerNumber)).toEqual(["01139997", "39139993"]);
    expect(prof.findings.map((f) => f.messageKey)).toContain("P06.overlap");
    // 前の保険の終わりと、新しい保険の始まりを確かめて入れると消える
    patients.confirmCoverage(`K17-${month(1)}`, "new1", { coverageId: prof.coverages[0].coverageId, source: "保険証・資格確認書", burdenRatio: 0.2, validFrom: null, validUntil: day(31) });
    const done = patients.confirmCoverage(`K17-${month(1)}`, "new1", { coverageId: prof.coverages[1].coverageId, source: "オンライン資格確認", burdenRatio: 0.1, validFrom: dateIn(1, 1), validUntil: dateIn(9, 31) });
    expect(done.findings.map((f) => f.checkId)).toEqual([]);
    ctx.sqlite.close();
  });

  it("同じ保険者番号・番号でも、生年月日が違えば別の人。氏名も番号も違えば別の人", () => {
    const { ctx, patients } = setup(() => [file([[claimId("K17"), person()], [claimId("K18"), person({ name: "架空　八重", sex: 2, birth: "19560501" })], [claimId("K9"), person({ name: "架空　九郎", insurer: { number: "01139997", symbol: "1", no: "00000009" } })]])]);
    const ids = [claimId("K17"), claimId("K18"), claimId("K9")].map((c) => patients.patientProfile(c).patientId);
    expect(new Set(ids).size).toBe(3);
    ctx.sqlite.close();
  });

  it("確かめて直した番号は、UKE を読み直しても加入情報を増やさない。確かめた人と根拠が残る", () => {
    const { ctx, clock, patients } = setup(() => [file([[claimId("K17"), person({ insurer: { number: "01139999", symbol: "1", no: "00000007" } })]])]);
    const before = patients.patientProfile(claimId("K17"));
    expect(before.findings.map((f) => f.messageKey)).toEqual(["P01.insurer_check_digit", "P03.missing", "P06.no_period_insurance"]);
    const after = patients.confirmCoverage(claimId("K17"), "new1", { coverageId: before.coverages[0].coverageId, source: "オンライン資格確認", payerNumber: "01139997", burdenRatio: 0.2, validFrom: null, validUntil: dateIn(9, 31) });
    expect(after.findings.map((f) => f.messageKey)).toEqual([]);
    expect(patients.patientProfile(claimId("K17")).coverages).toEqual([
      expect.objectContaining({ coverageId: before.coverages[0].coverageId, payerNumber: "01139997", burdenRatio: 0.2, validUntil: dateIn(9, 31), source: "オンライン資格確認", checkedBy: "new1", checkedAt: clock.now() }),
    ]);
    // 履歴は追記で残る
    expect(count(ctx.sqlite, "patient_coverages")).toBe(2);
    // 時計を期限の先に進めると「期限」が出る
    ctx.setSetting("now", `${dateIn(10, 1)}T09:00:00+09:00`);
    expect(patients.patientProfile(claimId("K17")).findings.map((f) => [f.kind, f.messageKey])).toContainEqual(["期限", "P06.expired"]);
    ctx.sqlite.close();
  });

  it("入力の誤り（ほかの患者の加入情報・期間の前後・公費への負担割合）は文言を返して断る", () => {
    const { ctx, patients } = setup(() => [file([[claimId("K17"), person({ kohi: [{ payerNo: "54139993", recipientNo: "9999996" }] })], [claimId("K18"), person({ name: "架空　八重", sex: 2, birth: "19560501", insurer: { number: "01139997", symbol: "1", no: "00000008" } })]])]);
    const mine = patients.patientProfile(claimId("K17")).coverages;
    const other = patients.patientProfile(claimId("K18")).coverages[0];
    const base = { source: "受給者証" as const, validFrom: null, validUntil: dateIn(9, 31) };
    expect(() => patients.confirmCoverage(claimId("K17"), "new1", { ...base, coverageId: other.coverageId })).toThrow(/この患者の加入情報ではありません/);
    expect(() => patients.confirmCoverage(claimId("K17"), "new1", { ...base, coverageId: mine[0].coverageId, validFrom: dateIn(10, 1) })).toThrow(/終わりより後/);
    expect(() => patients.confirmCoverage(claimId("K17"), "new1", { ...base, coverageId: mine[1].coverageId, burdenRatio: 0.1 })).toThrow(/医療保険の加入情報/);
    expect(() => patients.confirmCoverage(claimId("K17"), "new1", { ...base, coverageId: mine[0].coverageId, burdenRatio: 0.15 })).toThrow(/1 割・2 割・3 割/);
    expect(() => patients.confirmCoverage(claimId("K17"), "nobody", { ...base, coverageId: mine[0].coverageId })).toThrow(/登録されていない/);
    ctx.sqlite.close();
  });

  it("移行で作った患者（旧い鍵＝保険者番号-被保険者番号）は、次に UKE を読んだときに同じ人として埋まる", () => {
    const db = new Database(paths().dbFile);
    migrate(db, APP_MIGRATIONS.slice(0, 2));
    db.prepare(`INSERT INTO patient_facts (patient_key, fact_key, value, source, valid_until, checked_at, checked_by) VALUES ('01139997-00000007', 'careLevel', '2', '介護保険証', '${dateIn(9, 31)}', '${day(12)}T09:00:00+09:00', 'new1')`).run();
    db.close();
    const { ctx, patients } = setup(() => [file([[claimId("K17"), person()]])]);
    const got = patients.patientFacts(claimId("K17"));
    expect(got.patientId).toBe("P0001");
    expect(got.facts).toEqual([expect.objectContaining({ key: "careLevel", value: 2 })]);
    expect(ctx.sqlite.prepare("SELECT id, name, birth, source FROM patients").all()).toEqual([{ id: "P0001", name: "架空　七郎", birth: "19540401", source: "UKE" }]);
    expect(count(ctx.sqlite, "patient_coverages")).toBe(1);
    ctx.sqlite.close();
  });
});

describe("既存の合成データ（K1〜K6）", () => {
  it("年齢・保険種別を患者マスタから出しても、症例の JSON の値と同じで、ユスティの判定は変わらない", () => {
    const app = openApp(paths());
    for (const c of app.cases()) {
      const fixture = json<ClaimContext>(path.join(repo, "fixtures", "cases", `${c.claimId.split("-")[0]}.json`));
      expect(c.facts.age).toEqual(fixture.facts.age);
      expect(c.facts.insurance).toEqual(fixture.facts.insurance);
      // UKE には負担割合が載っていないので、患者マスタに入るまでは症例側の値をそのまま使う（「分からない」で消さない）
      expect(c.facts.burdenRatio).toEqual(fixture.facts.burdenRatio);
      expect(c.facts.burdenRatio.known).toBe(true);
      // 年齢・保険種別・負担割合を症例の JSON の値に戻しても、判定は同じ
      const withFixture = { ...c, facts: { ...c.facts, age: fixture.facts.age, insurance: fixture.facts.insurance, burdenRatio: fixture.facts.burdenRatio } };
      expect(evaluate(c)).toEqual(evaluate(withFixture));
      // 症例側に負担割合があるので、未入力の指摘は出ない
      expect(app.patientProfile(c.claimId).findings.map((f) => f.checkId)).not.toContain("P03");
    }
    app.close();
  });

  it("負担割合を確かめて入力すると、患者マスタの値が症例側の値より優先される", () => {
    const app = openApp(paths());
    app.upsertClerk({ id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" });
    const before = app.patientProfile(claimId("K1"));
    expect(before.caseBurdenRatio).toBe(0.1);
    const after = app.confirmCoverage(claimId("K1"), "new1", { coverageId: before.coverages[0].coverageId, source: "オンライン資格確認", burdenRatio: 0.2, validFrom: null, validUntil: dateIn(9, 31) });
    expect(after.coverages[0].burdenRatio).toBe(0.2);
    expect(app.caseOf(claimId("K1")).facts.burdenRatio).toEqual({ known: true, value: 0.2 });
    // ほかの患者は症例側の値のまま
    expect(app.caseOf(claimId("K2")).facts.burdenRatio).toEqual({ known: true, value: 0.1 });
    app.close();
  });

  it("患者情報チェックの指摘は、ユスティの指摘とは別に返る（ユスティの結果に P 系は混ざらない）", () => {
    const app = openApp(paths());
    const all = app.cases().flatMap((c) => evaluate(c).findings.map((f) => f.ruleId));
    expect(all.some((id) => id.startsWith("P"))).toBe(false);
    const k3 = app.patientProfile(claimId("K3"));
    expect(k3.findings.every((f) => /^P0[1-8]$/.test(f.checkId))).toBe(true);
    expect(k3.findings.length).toBeGreaterThan(0);
    // 画面に返す内容に、氏名と生年月日は入れない
    expect(JSON.stringify(k3)).not.toMatch(/架空|1946/);
    app.close();
  });
});

describe("連携のコネクタで読んだ患者（FR-123）", () => {
  it("フィクスチャ コネクタの患者は、UKE から入った同じ人に重なり、同じ患者情報チェックにかかる。何度読んでも増えない", async () => {
    const app = openApp(paths());
    const ym = claimId("K3").slice(-7);
    const fromUke = app.patientProfile(claimId("K3"));
    const k3 = await createFixtureConnector(repo).patient!.getPatient("K3");
    const got = app.checkConnectorPatient(k3, ym);
    expect(got.patientId).toBe(fromUke.patientId);
    expect(got.coverages.map((c) => [c.coverageId, c.kind, c.payerNumber])).toEqual(fromUke.coverages.map((c) => [c.coverageId, c.kind, c.payerNumber]));
    // コネクタが持ってきた負担割合は、患者マスタの履歴に足される（出所は「連携」）
    expect(got.coverages[0]).toMatchObject({ burdenRatio: 0.1, source: "連携", checkedBy: null });
    expect(got.findings.every((f) => /^P0[1-8]$/.test(f.checkId))).toBe(true);
    // 有効期間は合成データにないので、情報不足のまま
    expect(got.findings.filter((f) => f.checkId === "P06").map((f) => f.messageKey)).toEqual(["P06.no_period_insurance", "P06.no_period_kohi"]);
    const read = new Database(paths().dbFile, { readonly: true });
    const rows = count(read, "patient_coverages");
    app.checkConnectorPatient(k3, ym);
    expect(count(read, "patient_coverages")).toBe(rows);
    read.close();
    app.close();
  });

  it("記号・番号の全角は、患者マスタに入れる時点で半角にそろう。有効期間が来れば情報不足は消え、確かめた記録は上書きしない", () => {
    const { ctx, patients } = setup(() => []);
    const ym = claimId("K17").slice(-7);
    const record = (validUntil: string | null, wide = true): PatientRecord => ({
      name: "架空　七郎",
      sex: 1,
      birth: "19540401",
      coverages: [
        { kind: "医保", payerNumber: wide ? "０１１３９９９７" : "01139997", symbol: wide ? "ＡＢ－１" : "AB-1", memberNo: wide ? "０００００００７" : "00000007", burdenRatio: 0.3, validFrom: null, validUntil },
      ],
    });
    const first = patients.checkConnectorPatient(record(null), ym);
    expect(first.coverages.map((c) => [c.payerNumber, c.symbol, c.memberNo, c.source])).toEqual([["01139997", "AB-1", "00000007", "連携"]]);
    expect(first.findings.map((f) => f.messageKey)).toEqual(["P06.no_period_insurance"]);
    // 半角で来た同じ人は、同じ患者・同じ加入情報。有効期間が入ると、情報不足が消える
    const second = patients.checkConnectorPatient(record(dateIn(5, 31), false), ym);
    expect([second.patientId, second.coverages.length, second.coverages[0].coverageId]).toEqual([first.patientId, 1, first.coverages[0].coverageId]);
    expect(second.coverages[0].validUntil).toBe(dateIn(5, 31));
    expect(second.findings.map((f) => f.messageKey)).not.toContain("P06.no_period_insurance");
    expect(count(ctx.sqlite, "patients")).toBe(1);
    // 医療事務が確かめた記録は、コネクタの値で上書きしない
    ctx.sqlite.prepare("UPDATE patient_coverages SET checked_by = 'new1', checked_at = ? WHERE id = (SELECT MAX(id) FROM patient_coverages)").run(`${day(13)}T09:00:00+09:00`);
    expect(patients.checkConnectorPatient(record(dateIn(8, 30)), ym).coverages[0].validUntil).toBe(dateIn(5, 31));
    ctx.sqlite.close();
  });
});
