// 患者情報チェックのルート（加入情報と指摘の取得、保険・公費の確認入力）。実際のルート（app/api/**/route.ts）を呼んで確かめる
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";

let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-patients-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const auth = () => instance.getAuth();
const cookieOf = (u: User) => `resemen_session=${auth().createSession(u.id).token}`;
const get = (url: string, cookie: string | null) => new Request(`http://localhost${url}`, { headers: cookie ? { cookie } : {} });
const post = (url: string, cookie: string | null, body?: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (claimId: string) => ({ params: Promise.resolve({ claimId }) });
const switchTo = async (cookie: string, role: Role) => (await import("../../app/api/auth/role/route")).POST(post("/api/auth/role", cookie, { role }));

const CLAIM = "K3-2025-03";
const profileUrl = `/api/patients/${CLAIM}/profile`;
const coverageUrl = `/api/patients/${CLAIM}/coverages`;

describe("患者情報チェックのルート", () => {
  it("未ログインは 401。事務の役割で加入情報と指摘が取れ、氏名・生年月日は返らない", async () => {
    const GET = (await import("../../app/api/patients/[claimId]/profile/route")).GET;
    const POST = (await import("../../app/api/patients/[claimId]/coverages/route")).POST;
    expect((await GET(get(profileUrl, null), params(CLAIM))).status).toBe(401);
    expect((await POST(post(coverageUrl, null, {}), params(CLAIM))).status).toBe(401);

    const owner = auth().register("patients_owner", "やまだ", "password123");
    const res = await GET(get(profileUrl, cookieOf(owner)), params(CLAIM));
    expect(res.status).toBe(200);
    const text = await res.text();
    const d = JSON.parse(text) as { coverages: { kind: string }[]; findings: { checkId: string; text: string }[] };
    expect(d.coverages.map((c) => c.kind)).toEqual(["医保", "公費"]);
    expect(d.findings.length).toBeGreaterThan(0);
    expect(d.findings.every((f) => f.text.length > 0)).toBe(true);
    expect(text).not.toMatch(/架空|19460401/);
    // パスの区切りを含む id は 400
    expect((await GET(get("/api/patients/x/profile", cookieOf(owner)), params("../K3"))).status).toBe(400);
  });

  it("確認入力：スキーマ違反は 400、確かめた人はセッションの本人、医師の役割は 403。監査ログに氏名・番号が入らない", async () => {
    const GET = (await import("../../app/api/patients/[claimId]/profile/route")).GET;
    const POST = (await import("../../app/api/patients/[claimId]/coverages/route")).POST;
    const owner = auth().register("patients_owner2", "さとう", "password123");
    const cookie = cookieOf(owner);
    const before = (await (await GET(get(profileUrl, cookie), params(CLAIM))).json()) as { coverages: { coverageId: string; kind: string }[]; findings: { messageKey: string; coverageId?: string }[] };
    const med = before.coverages[0];
    expect(before.findings.filter((f) => f.coverageId === med.coverageId).map((f) => f.messageKey)).toEqual(["P01.insurer_check_digit", "P06.no_period_insurance"]);
    const coverage = { coverageId: med.coverageId, source: "オンライン資格確認", payerNumber: "39139993", burdenRatio: 0.1, validFrom: null, validUntil: "2025-07-31" };

    // 確かめた人の名前を送っても受け取らない／根拠が選択肢にない／日付の形が違う
    const named = await POST(post(coverageUrl, cookie, { coverage: { ...coverage, checkedBy: "院長" } }), params(CLAIM));
    expect(named.status).toBe(400);
    expect((await named.json()).fields).toEqual(["coverage.checkedBy"]);
    expect((await POST(post(coverageUrl, cookie, { coverage: { ...coverage, source: "なんとなく" } }), params(CLAIM))).status).toBe(400);
    expect((await POST(post(coverageUrl, cookie, { coverage: { ...coverage, validUntil: "2025/07/31" } }), params(CLAIM))).status).toBe(400);
    expect((await POST(post(coverageUrl, cookie, { coverage: { ...coverage, payerNumber: "39-139993" } }), params(CLAIM))).status).toBe(400);

    const ok = await POST(post(coverageUrl, cookie, { coverage }), params(CLAIM));
    expect(ok.status).toBe(200);
    const after = (await ok.json()) as { coverages: { coverageId: string; checkedBy: string; source: string; payerNumber: string }[]; findings: { messageKey: string; coverageId?: string }[] };
    // 医保についての指摘が消え、確かめた人はセッションの本人の医療事務 id
    expect(after.findings.filter((f) => f.coverageId === med.coverageId)).toEqual([]);
    expect(after.coverages[0]).toMatchObject({ payerNumber: "39139993", source: "オンライン資格確認", checkedBy: instance.clerkIdOf(owner) });

    // 医師の役割ではできない
    expect((await switchTo(cookie, "doctor")).status).toBe(200);
    expect((await POST(post(coverageUrl, cookie, { coverage }), params(CLAIM))).status).toBe(403);
    expect((await GET(get(profileUrl, cookie), params(CLAIM))).status).toBe(403);

    // 監査ログ：対象は請求 id だけ。番号・氏名・期限は入らない
    const rows = instance.runAs(owner, () => instance.getApp().audit.list()).reverse();
    expect(rows.map((r) => [r.action, r.target, r.result])).toEqual([
      ["POST /api/patients/[claimId]/coverages", CLAIM, "invalid"],
      ["POST /api/patients/[claimId]/coverages", CLAIM, "invalid"],
      ["POST /api/patients/[claimId]/coverages", CLAIM, "invalid"],
      ["POST /api/patients/[claimId]/coverages", CLAIM, "invalid"],
      ["POST /api/patients/[claimId]/coverages", CLAIM, "ok"],
      ["POST /api/auth/role", "doctor", "ok"],
      ["POST /api/patients/[claimId]/coverages", CLAIM, "denied"],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/39139993|39139999|54139999|架空|さとう|2025-07-31/);
  });
});
