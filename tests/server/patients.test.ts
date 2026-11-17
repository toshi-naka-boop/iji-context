// 患者マスタへの取り込み（src/server/app/patients.ts）。UKE の中身は差し替えられるよう、UKE の読み込みだけを偽物にして組み立てる
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_MIGRATIONS, migrate } from "../../src/db/migrate";
import { evaluate } from "../../src/engine";
import type { ClaimContext } from "../../src/engine/types";
import { openApp } from "../../src/server/app";
import { createClerks } from "../../src/server/app/clerks";
import { createClock } from "../../src/server/app/clock";
import { json, openContext } from "../../src/server/app/context";
import { createPatients } from "../../src/server/app/patients";
import type { Uke } from "../../src/server/app/uke";
import type { UkeFile, UkePatient } from "../../src/uke/types";

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
  billingMonth: "2025-04",
  receipts: receipts.map(([claimId, patient]) => ({ claimId, yearMonth: claimId.slice(-7), patient, lines: [{ kubun: "C001_1I", count: 1, dates: [`${claimId.slice(-7)}-05`] }], comments: [] })),
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
    const { ctx, patients } = setup(() => [file([["K7-2025-03", p]])]);
    const first = patients.patientProfile("K7-2025-03");
    patients.patientProfile("K7-2025-03");
    patients.patientFacts("K7-2025-03");
    expect(count(ctx.sqlite, "patients")).toBe(1);
    expect(count(ctx.sqlite, "patient_coverages")).toBe(2);
    expect(first.patientId).toBe("P0001");
    expect(first.coverages.map((c) => [c.kind, c.position, c.payerNumber, c.memberNo, c.source])).toEqual([["医保", 0, "01139997", "00000007", "UKE"], ["公費", 1, "54139993", "9999996", "UKE"]]);
    ctx.sqlite.close();
  });

  it("保険が変わっても同じ人として続き、確かめた患者情報は同じ患者に付いたままになる", () => {
    let current = file([["K7-2025-03", person()]]);
    const { ctx, patients } = setup(() => [current]);
    patients.savePatientFact("K7-2025-03", "new1", { key: "careLevel", value: 3, source: "介護保険証", validUntil: "2025-12-31" });
    const before = patients.patientFacts("K7-2025-03");

    // 翌月、後期高齢者医療に変わった（氏名の空白の違いは同じ人として扱う）
    current = file([["K7-2025-04", person({ name: "架空 七郎", receiptType: "1318", insurer: { number: "39139993", symbol: "", no: "00000077" } })]]);
    const after = patients.patientFacts("K7-2025-04");
    expect(after.patientId).toBe(before.patientId);
    expect(after.facts).toEqual([expect.objectContaining({ key: "careLevel", value: 3, checkedBy: "new1" })]);
    expect(count(ctx.sqlite, "patients")).toBe(1);
    // 加入情報は 2 件になり、期限が分からないあいだは、どちらが有効かを確かめるよう指摘が出る
    const prof = patients.patientProfile("K7-2025-04");
    expect(prof.coverages.map((c) => c.payerNumber)).toEqual(["01139997", "39139993"]);
    expect(prof.findings.map((f) => f.messageKey)).toContain("P06.overlap");
    // 前の保険の終わりと、新しい保険の始まりを確かめて入れると消える
    patients.confirmCoverage("K7-2025-04", "new1", { coverageId: prof.coverages[0].coverageId, source: "保険証・資格確認書", burdenRatio: 0.2, validFrom: null, validUntil: "2025-03-31" });
    const done = patients.confirmCoverage("K7-2025-04", "new1", { coverageId: prof.coverages[1].coverageId, source: "オンライン資格確認", burdenRatio: 0.1, validFrom: "2025-04-01", validUntil: "2026-07-31" });
    expect(done.findings.map((f) => f.checkId)).toEqual([]);
    ctx.sqlite.close();
  });

  it("同じ保険者番号・番号でも、生年月日が違えば別の人。氏名も番号も違えば別の人", () => {
    const { ctx, patients } = setup(() => [file([["K7-2025-03", person()], ["K8-2025-03", person({ name: "架空　八重", sex: 2, birth: "19560501" })], ["K9-2025-03", person({ name: "架空　九郎", insurer: { number: "01139997", symbol: "1", no: "00000009" } })]])]);
    const ids = ["K7-2025-03", "K8-2025-03", "K9-2025-03"].map((c) => patients.patientProfile(c).patientId);
    expect(new Set(ids).size).toBe(3);
    ctx.sqlite.close();
  });

  it("確かめて直した番号は、UKE を読み直しても加入情報を増やさない。確かめた人と根拠が残る", () => {
    const { ctx, clock, patients } = setup(() => [file([["K7-2025-03", person({ insurer: { number: "01139999", symbol: "1", no: "00000007" } })]])]);
    const before = patients.patientProfile("K7-2025-03");
    expect(before.findings.map((f) => f.messageKey)).toEqual(["P01.insurer_check_digit", "P03.missing", "P06.no_period_insurance", "P07.missing"]);
    const after = patients.confirmCoverage("K7-2025-03", "new1", { coverageId: before.coverages[0].coverageId, source: "オンライン資格確認", payerNumber: "01139997", burdenRatio: 0.2, validFrom: null, validUntil: "2025-07-31" });
    expect(after.findings.map((f) => f.messageKey)).toEqual(["P07.missing"]);
    expect(patients.patientProfile("K7-2025-03").coverages).toEqual([
      expect.objectContaining({ coverageId: before.coverages[0].coverageId, payerNumber: "01139997", burdenRatio: 0.2, validUntil: "2025-07-31", source: "オンライン資格確認", checkedBy: "new1", checkedAt: clock.now() }),
    ]);
    // 履歴は追記で残る
    expect(count(ctx.sqlite, "patient_coverages")).toBe(2);
    // 時計を期限の先に進めると「期限」が出る
    ctx.setSetting("now", "2025-08-01T09:00:00+09:00");
    expect(patients.patientProfile("K7-2025-03").findings.map((f) => [f.kind, f.messageKey])).toContainEqual(["期限", "P06.expired"]);
    ctx.sqlite.close();
  });

  it("入力の誤り（ほかの患者の加入情報・期間の前後・公費への負担割合）は文言を返して断る", () => {
    const { ctx, patients } = setup(() => [file([["K7-2025-03", person({ kohi: [{ payerNo: "54139993", recipientNo: "9999996" }] })], ["K8-2025-03", person({ name: "架空　八重", sex: 2, birth: "19560501", insurer: { number: "01139997", symbol: "1", no: "00000008" } })]])]);
    const mine = patients.patientProfile("K7-2025-03").coverages;
    const other = patients.patientProfile("K8-2025-03").coverages[0];
    const base = { source: "受給者証" as const, validFrom: null, validUntil: "2025-12-31" };
    expect(() => patients.confirmCoverage("K7-2025-03", "new1", { ...base, coverageId: other.coverageId })).toThrow(/この患者の加入情報ではありません/);
    expect(() => patients.confirmCoverage("K7-2025-03", "new1", { ...base, coverageId: mine[0].coverageId, validFrom: "2026-01-01" })).toThrow(/終わりより後/);
    expect(() => patients.confirmCoverage("K7-2025-03", "new1", { ...base, coverageId: mine[1].coverageId, burdenRatio: 0.1 })).toThrow(/医療保険の加入情報/);
    expect(() => patients.confirmCoverage("K7-2025-03", "new1", { ...base, coverageId: mine[0].coverageId, burdenRatio: 0.15 })).toThrow(/1 割・2 割・3 割/);
    expect(() => patients.confirmCoverage("K7-2025-03", "nobody", { ...base, coverageId: mine[0].coverageId })).toThrow(/登録されていない/);
    ctx.sqlite.close();
  });

  it("移行で作った患者（旧い鍵＝保険者番号-被保険者番号）は、次に UKE を読んだときに同じ人として埋まる", () => {
    const db = new Database(paths().dbFile);
    migrate(db, APP_MIGRATIONS.slice(0, 2));
    db.prepare("INSERT INTO patient_facts (patient_key, fact_key, value, source, valid_until, checked_at, checked_by) VALUES ('01139997-00000007', 'careLevel', '2', '介護保険証', '2025-12-31', '2025-03-10T09:00:00+09:00', 'new1')").run();
    db.close();
    const { ctx, patients } = setup(() => [file([["K7-2025-03", person()]])]);
    const got = patients.patientFacts("K7-2025-03");
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
      // UKE には負担割合が載っていないので、確かめて入力するまでは「分からない」になる
      expect(c.facts.burdenRatio).toEqual({ known: false });
      // 年齢・保険種別・負担割合を症例の JSON の値に戻しても、判定は同じ
      const withFixture = { ...c, facts: { ...c.facts, age: fixture.facts.age, insurance: fixture.facts.insurance, burdenRatio: fixture.facts.burdenRatio } };
      expect(evaluate(c)).toEqual(evaluate(withFixture));
    }
    app.close();
  });

  it("患者情報チェックの指摘は、ユスティの指摘とは別に返る（ユスティの結果に P 系は混ざらない）", () => {
    const app = openApp(paths());
    const all = app.cases().flatMap((c) => evaluate(c).findings.map((f) => f.ruleId));
    expect(all.some((id) => id.startsWith("P"))).toBe(false);
    const k3 = app.patientProfile("K3-2025-03");
    expect(k3.findings.every((f) => /^P0[1-8]$/.test(f.checkId))).toBe(true);
    expect(k3.findings.length).toBeGreaterThan(0);
    // 画面に返す内容に、氏名と生年月日は入れない
    expect(JSON.stringify(k3)).not.toMatch(/架空|1946/);
    app.close();
  });
});
