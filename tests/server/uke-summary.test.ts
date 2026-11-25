// 取り込んだレセプトの全件の一覧（採点 r1 医療事務課長 P1-1）。件数が、UKE に書いてあるとおりの点検（GET /api/uke/claims/[claimId]/check）と合う
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import { autoConsent } from "../helpers/consent";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-uke-summary-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const cookieOf = (u: User) => `resemen_session=${instance.getAuth().createSession(u.id).token}`;
const summary = async (cookie: string) => (await import("../../app/api/uke/summary/route")).GET(new Request("http://localhost/api/uke/summary", { headers: { cookie } }));

describe("取り込んだレセプトの全件の一覧", () => {
  it("取り込んだ全件が並び、確定・条件つき・情報不足・見ていない行の数が、点検の結果と合う。何も記録しない", async () => {
    const owner = instance.getAuth().register("summary_owner", "かちょう", "password123");
    const cookie = cookieOf(owner);
    const clerkId = instance.clerkIdOf(owner);
    // 取り込む前は空
    expect(await (await summary(cookie)).json()).toEqual([]);
    instance.runAs(owner, () => {
      const a = instance.getApp();
      a.importUke(clerkId, "kokuhoren.UKE");
      a.uploadUke(clerkId, readFileSync(path.join(repo, "fixtures", "uke", "kisaimore.UKE")));
    });
    const r = await summary(cookie);
    expect(r.status).toBe(200);
    const rows = (await r.json()) as { claimId: string; state: string; confirmed: number; conditional: number; missing: number; unchecked: number; reviewed?: boolean }[];
    const listed = instance.runAs(owner, () => instance.getApp().ukeList(clerkId).filter((u) => u.imported).flatMap((u) => u.receipts.map((x) => x.claimId)));
    expect(rows.map((x) => x.claimId)).toEqual(listed);
    // デモのクリニックでは「確かめ済み」を持たない
    expect(rows.every((x) => x.reviewed === undefined)).toBe(true);
    // 件数は点検（UKE のとおり）と同じ数え方
    for (const row of rows.filter((x) => x.state === "checked")) {
      const c = instance.runAs(owner, () => instance.getApp().ukeCheck(row.claimId, clerkId)) as { findings: { params?: Record<string, string> }[]; generic?: { findings: { certainty: string }[] }; rows: { checkedBy: string }[] };
      const generic = c.generic?.findings ?? [];
      expect([row.claimId, row.confirmed, row.conditional, row.unchecked]).toEqual([
        row.claimId,
        c.findings.filter((f) => f.params?.conditional !== "1").length + generic.filter((f) => f.certainty === "確定").length,
        c.findings.filter((f) => f.params?.conditional === "1").length + generic.filter((f) => f.certainty === "条件つき").length,
        c.rows.filter((x) => x.checkedBy === "none").length,
      ]);
      expect(row.missing).toBeGreaterThan(0);
    }
    // 記載を 1 つ欠いた見本（U1-1）には、確定の指摘（記載もれ）がある
    expect(rows.find((x) => x.claimId === "U1-1")?.confirmed).toBeGreaterThan(0);
    // 事務長も読める。医師は読めない
    instance.getAuth().switchRole(owner, "manager");
    expect((await summary(cookie)).status).toBe(200);
    instance.getAuth().switchRole(owner, "doctor");
    expect((await summary(cookie)).status).toBe(403);
  });
  it("患者情報の指摘（P 系）の件数が、点検の患者情報の指摘と合う。確定・条件つきには入れない", async () => {
    const owner = instance.getAuth().register("summary_patient", "かちょう", "password123");
    const cookie = cookieOf(owner);
    const clerkId = instance.clerkIdOf(owner);
    instance.runAs(owner, () => instance.getApp().importUke(clerkId, "kozoka.UKE"));
    const rows = (await (await summary(cookie)).json()) as { claimId: string; state: string; patientFindings: number }[];
    for (const row of rows.filter((x) => x.state === "checked")) {
      const c = instance.runAs(owner, () => instance.getApp().ukeCheck(row.claimId, clerkId)) as { patientFindings: unknown[] };
      expect([row.claimId, row.patientFindings]).toEqual([row.claimId, c.patientFindings.length]);
    }
    // 見本の K12 は保険者番号の検証番号が合わず、P01 が出る（採点 r2 医療事務課長 P1-1）
    expect(rows.find((x) => x.claimId.startsWith("K12"))?.patientFindings).toBeGreaterThan(0);
  });
  it("カルテ側の記録がない（chartRecord）は、一覧の情報不足（missingOpen）に数えず「見ていないこと」に 1 つ数える（入力で消えないため）", async () => {
    const owner = instance.getAuth().register("summary_unseen", "かちょう", "password123");
    const cookie = cookieOf(owner);
    const clerkId = instance.clerkIdOf(owner);
    instance.runAs(owner, () => instance.getApp().importUke(clerkId, "kokuhoren.UKE"));
    const rows = (await (await summary(cookie)).json()) as { claimId: string; state: string; missingOpen: number; unseen: number }[];
    const checked = rows.filter((x) => x.state === "checked");
    expect(checked.length).toBeGreaterThan(0);
    for (const row of checked) {
      const c = instance.runAs(owner, () => instance.getApp().ukeCheck(row.claimId, clerkId)) as { missing: { missing?: { field: string } }[] };
      const chart = c.missing.filter((f) => f.missing?.field === "chartRecord").length;
      const rest = c.missing.filter((f) => f.missing?.field !== "chartRecord");
      const shared = new Set(rest.filter((f) => f.missing?.field === "unsupportedLines").map(() => "unsupportedLines")).size;
      expect([row.claimId, row.missingOpen, row.unseen]).toEqual([row.claimId, rest.filter((f) => f.missing?.field !== "unsupportedLines").length + shared, chart > 0 ? 1 : 0]);
    }
    // 記録を読むルールが当たる請求がある（見本の国保連）
    expect(checked.some((x) => x.unseen === 1)).toBe(true);
  });
});
