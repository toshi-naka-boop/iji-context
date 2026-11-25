// 取り込んだレセプトの点検の画面から、患者情報の指摘（P06 有効期限・P03 負担割合）を入れる（採点 r4 医療事務課長 P1-2）。
// 画面は算定画面と同じ部品（app/work/patient-panel.tsx の CoverageCheck）で、同じ入口（GET /profile・POST /coverages）を、取り込んだ請求の id で呼ぶ。
// 入れると、その請求の点検（/check）と全件の一覧（/summary）の患者情報の指摘から消える
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import { autoConsent } from "../helpers/consent";
import { dateIn } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");
let owner: User;
let cookie: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-uke-coverage-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("coverage_inline", "やまだ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const get = (u: string) => new Request(`http://localhost${u}`, { headers: { cookie } });
const params = (claimId: string) => ({ params: Promise.resolve({ claimId }) });
type Row = { claimId: string; state: string; patientFindings: number };
const summary = async () => (await (await (await import("../../app/api/uke/summary/route")).GET(get("/api/uke/summary"))).json()) as Row[];
const patientIdsOf = async (claimId: string) => ((await (await (await import("../../app/api/uke/claims/[claimId]/check/route")).GET(get(`/api/uke/claims/${claimId}/check`), params(claimId))).json()) as { patientFindings: { checkId: string }[] }).patientFindings.map((f) => f.checkId);
type Profile = { coverages: { coverageId: string; kind: string }[]; findings: { checkId: string }[] };
const profileOf = async (claimId: string) => (await (await (await import("../../app/api/patients/[claimId]/profile/route")).GET(get(`/api/patients/${claimId}/profile`), params(claimId))).json()) as Profile;
/** 画面の「残す」と同じ形で送る（app/work/patient-panel.tsx の saveCoverage） */
const saveCoverage = async (claimId: string, coverage: Record<string, unknown>) =>
  (await import("../../app/api/patients/[claimId]/coverages/route")).POST(new Request(`http://localhost/api/patients/${claimId}/coverages`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ coverage }) }), params(claimId));

describe("取り込んだレセプトの点検の画面から、患者情報の指摘を入れる", () => {
  it("アップロードした請求の P06（有効期限）と P03（負担割合）は、点検の画面の入力で入れると、点検と全件の一覧から消える", async () => {
    const clerkId = instance.clerkIdOf(owner);
    instance.runAs(owner, () => instance.getApp().uploadUke(clerkId, readFileSync(path.join(repo, "fixtures", "uke", "kisaimore.UKE"))));
    const before = (await summary()).filter((r) => r.state === "checked");
    let fixed = 0;
    for (const row of before) {
      const ids = await patientIdsOf(row.claimId);
      if (!ids.includes("P06") && !ids.includes("P03")) continue;
      // 点検の画面の患者情報の指摘と、部品が読む加入情報の指摘は同じ
      const p = await profileOf(row.claimId);
      expect(p.findings.map((f) => f.checkId)).toEqual(ids);
      const med = p.coverages.find((c) => c.kind === "医保")!;
      // 負担割合は、P03 が消える値を選ぶ（年齢とレセプト種別で決まる。画面でも選択肢から選ぶ）
      for (const burdenRatio of [0.3, 0.2, 0.1]) {
        expect((await saveCoverage(row.claimId, { coverageId: med.coverageId, source: "オンライン資格確認", ...(ids.includes("P03") ? { burdenRatio } : {}), validFrom: null, validUntil: dateIn(9, 30) })).status).toBe(200);
        if (!(await patientIdsOf(row.claimId)).includes("P03")) break;
      }
      const after = await patientIdsOf(row.claimId);
      expect([row.claimId, after.includes("P06"), after.includes("P03")]).toEqual([row.claimId, false, false]);
      const listed = (await summary()).find((r) => r.claimId === row.claimId)!;
      expect(listed.patientFindings).toBe(after.length);
      expect(listed.patientFindings).toBeLessThan(row.patientFindings);
      fixed++;
    }
    expect(fixed).toBeGreaterThan(0);
  });
});
