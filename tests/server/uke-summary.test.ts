// 取り込んだレセプトの全件の一覧（採点 r1 医療事務課長 P1-1）。件数が、UKE に書いてあるとおりの点検（GET /api/uke/claims/[claimId]/check）と合う
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
  it("カルテ側の記録がない（chartRecord）は、一覧の情報不足（missingOpen）に数えず「見ていないこと」に 1 つ数える（入力で消えないため）。介護・ほかの機関の調整の「見ていません」も文の数だけ足す", async () => {
    const owner = instance.getAuth().register("summary_unseen", "かちょう", "password123");
    const cookie = cookieOf(owner);
    const clerkId = instance.clerkIdOf(owner);
    instance.runAs(owner, () => instance.getApp().importUke(clerkId, "kokuhoren.UKE"));
    const rows = (await (await summary(cookie)).json()) as { claimId: string; state: string; missingOpen: number; unseen: number }[];
    const checked = rows.filter((x) => x.state === "checked");
    expect(checked.length).toBeGreaterThan(0);
    for (const row of checked) {
      const c = instance.runAs(owner, () => instance.getApp().ukeCheck(row.claimId, clerkId)) as { missing: { missing?: { field: string } }[]; careUnseen: string[] };
      const chart = c.missing.filter((f) => f.missing?.field === "chartRecord").length;
      const rest = c.missing.filter((f) => f.missing?.field !== "chartRecord");
      const shared = new Set(rest.filter((f) => f.missing?.field === "unsupportedLines").map(() => "unsupportedLines")).size;
      expect([row.claimId, row.missingOpen, row.unseen]).toEqual([row.claimId, rest.filter((f) => f.missing?.field !== "unsupportedLines").length + shared, (chart > 0 ? 1 : 0) + c.careUnseen.length]);
    }
    // 聞き取りに答えていない請求がある（見本の国保連。聞き取りの画面の「見ていない」と同じ文。採点 r2 医療事務課長 P1-3）
    const k1 = rows.find((x) => x.claimId.startsWith("K1-"))!;
    const careOfK1 = instance.runAs(owner, () => instance.getApp().careCheck(undefined, k1.claimId)).targets.find((t) => t.claimId === k1.claimId);
    expect(careOfK1?.notDone).toBe(true);
    expect(k1.unseen).toBe(1 + careOfK1!.notes.length);
  });
  it("締めの数：まだ手を付ける残り（open）と、仕組み上いつも残るもの（fixedUnseen。入力で消えない）を分けて数える。有効期限（P06）は確かめて入れると消え、次に読んでも戻らない（採点 r3 医療事務課長 #3）", async () => {
    const owner = instance.getAuth().register("summary_open", "かちょう", "password123");
    const cookie = cookieOf(owner);
    const clerkId = instance.clerkIdOf(owner);
    instance.runAs(owner, () => instance.getApp().uploadUke(clerkId, readFileSync(path.join(repo, "fixtures", "uke", "kisaimore.UKE"))));
    type Row = { claimId: string; state: string; confirmed: number; conditional: number; missingOpen: number; patientFindings: number; unseen: number; open: boolean; fixedUnseen: number };
    const rowsOf = async () => (await (await summary(cookie)).json()) as Row[];
    for (const row of (await rowsOf()).filter((x) => x.state === "checked")) {
      const c = instance.runAs(owner, () => instance.getApp().ukeCheck(row.claimId, clerkId)) as { missing: { missing?: { field: string } }[]; careUnseen: string[] };
      const fixed = c.missing.some((f) => f.missing?.field === "chartRecord") ? 1 : 0;
      expect([row.claimId, row.fixedUnseen, row.unseen - row.fixedUnseen, row.open]).toEqual([row.claimId, fixed, c.careUnseen.length, row.confirmed + row.conditional + row.missingOpen + row.patientFindings + c.careUnseen.length > 0]);
    }
    // カルテのない請求の「見ていないこと」は、入力では消えないほうに数える
    const before = (await rowsOf()).find((x) => x.claimId === "U1-1")!;
    expect(before.fixedUnseen).toBe(1);
    // P06（有効期限が入っていない）は規則のとおり（FR-122）に出る。確かめて入れると消え、一覧を読み直しても（UKE を読み直しても）戻らない
    const profile = await import("../../app/api/patients/[claimId]/profile/route");
    const params = { params: Promise.resolve({ claimId: "U1-1" }) };
    const p = (await (await profile.GET(new Request("http://localhost/api/patients/U1-1/profile", { headers: { cookie } }), params)).json()) as { coverages: { coverageId: string; kind: string }[]; findings: { checkId: string }[] };
    expect(p.findings.some((f) => f.checkId === "P06")).toBe(true);
    const med = p.coverages.find((c) => c.kind === "医保")!;
    const coverages = await import("../../app/api/patients/[claimId]/coverages/route");
    const res = await coverages.POST(new Request("http://localhost/api/patients/U1-1/coverages", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ coverage: { coverageId: med.coverageId, source: "オンライン資格確認", validFrom: null, validUntil: dateIn(9, 30) } }) }), params);
    expect(res.status).toBe(200);
    for (let i = 0; i < 2; i++) {
      const after = (await rowsOf()).find((x) => x.claimId === "U1-1")!;
      const c = instance.runAs(owner, () => instance.getApp().ukeCheck("U1-1", clerkId)) as { patientFindings: { checkId: string }[] };
      expect(c.patientFindings.some((f) => f.checkId === "P06")).toBe(false);
      expect(after.patientFindings).toBeLessThan(before.patientFindings);
      expect(after.fixedUnseen).toBe(1);
    }
  });
});
