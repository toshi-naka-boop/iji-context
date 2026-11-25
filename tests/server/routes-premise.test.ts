// 条件つきの指摘の「前提を確かめた」（採点 r4 医療事務課長 P1-1）：確かめた条件つきの指摘は、全件の一覧の「残り」から外れる。取り消すと戻る。
// 確定の指摘・出ていない指摘の鍵は断る。残せるのは医療事務（事務・ベテラン）で、事務長・医師は 403。誰がいつ確かめたかが残り、監査ログにも残る
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Finding } from "../../src/engine/types";
import type { User } from "../../src/server/auth";
import { conditionalKeysOf, handPremiseKey } from "../../src/uke/premise";
import { writeUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";
import { fileOf, receiptOf } from "../helpers/care";
import { day, YM } from "../helpers/period";

let tmp: string;
let instance: typeof import("../../src/server/instance");
let owner: User;
let cookie: string;
const ID = "U1-1";
const masters = process.env.RESEMEN_MASTER_DIR ? path.join(process.env.RESEMEN_MASTER_DIR, "masters.db") : "";
const hasMasters = masters !== "" && existsSync(masters);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-premise-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("premise_owner", "やまだ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
  // 訪問診療料(Ⅰ)2 だけの月（R01 の条件つきの指摘「当院が主治医の機関でなければ」が出る）
  const file = fileOf([receiptOf(1, YM, [{ kubun: "C001_2I", count: 2, dates: [day(6), day(20)] }, { kubun: "C002_2RO1", count: 1, dates: [day(20)] }])]);
  instance.runAs(owner, () => expect(instance.getApp().uploadUke(instance.clerkIdOf(owner), writeUke(file)).filter((u) => u.uploaded).flatMap((u) => u.receipts.map((x) => x.claimId))).toEqual([ID]));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const post = (body: unknown) => new Request(`http://localhost/api/uke/claims/${ID}/premise`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ claimId: ID }) };
const route = () => import("../../app/api/uke/claims/[claimId]/premise/route");
type Row = { claimId: string; confirmed: number; conditional: number; conditionalChecked: number; missingOpen: number; patientFindings: number; unseen: number; fixedUnseen: number; open: boolean };
const rowOf = async () => ((await (await (await import("../../app/api/uke/summary/route")).GET(new Request("http://localhost/api/uke/summary", { headers: { cookie } }))).json()) as Row[]).find((r) => r.claimId === ID)!;
type Check = { findings: Finding[]; generic?: { findings: { check: string; messageKey: string; certainty: string; codes: { code: string }[] }[] }; premiseChecks: { key: string; outcome: string; by: string; at: string }[] };
const checkOf = async () => (await (await (await import("../../app/api/uke/claims/[claimId]/check/route")).GET(new Request(`http://localhost/api/uke/claims/${ID}/check`, { headers: { cookie } }), params)).json()) as Check;
/** 残りのうち、条件つきの指摘を除いた分 */
const othersOf = (r: Row) => r.confirmed + r.missingOpen + r.patientFindings + (r.unseen - r.fixedUnseen);
const auditRows = () => {
  const db = new Database(instance.tenantPaths(owner.tenantId).dbFile, { readonly: true });
  try {
    return db.prepare("SELECT action, target FROM audit_log WHERE action = ? ORDER BY id").all("POST /api/uke/claims/[claimId]/premise") as { action: string; target: string }[];
  } finally {
    db.close();
  }
};

describe("条件つきの指摘の「前提を確かめた」", () => {
  it("確かめた条件つきの指摘は残りから外れ、取り消すと戻る。誰がいつ確かめたかと監査ログが残る", async () => {
    const before = await checkOf();
    const keys = conditionalKeysOf(before);
    const r01 = before.findings.find((f) => f.messageKey === "R01.visit2_only")!;
    expect(r01.params?.conditional).toBe("1");
    expect(keys).toContain(handPremiseKey(r01));
    expect(before.premiseChecks).toEqual([]);
    const row0 = await rowOf();
    expect([row0.conditional, row0.conditionalChecked, row0.open]).toEqual([keys.length, 0, true]);

    // 全部の条件つきの指摘を確かめる（ひとつは「当たらない」、ほかは「当たるので直す」）
    for (const [i, key] of keys.entries()) expect((await (await route()).POST(post({ key, outcome: i === 0 ? "notApplies" : "fix" }), params)).status).toBe(200);
    const after = await checkOf();
    expect(after.premiseChecks.map((p) => [p.key, p.outcome, p.by])).toEqual(keys.map((k, i) => [k, i === 0 ? "notApplies" : "fix", "やまだ"]));
    expect(after.premiseChecks.every((p) => p.at.length > 0)).toBe(true);
    const row1 = await rowOf();
    expect([row1.conditional, row1.conditionalChecked]).toEqual([keys.length, keys.length]);
    // 条件つきのほかに残るものがなければ、残りから外れる
    expect(row1.open).toBe(othersOf(row1) > 0);

    // 取り消すと戻る（取り消しも記録に残る）
    expect((await (await route()).POST(post({ key: keys[0], outcome: null }), params)).status).toBe(200);
    const row2 = await rowOf();
    expect([row2.conditionalChecked, row2.open]).toEqual([keys.length - 1, true]);
    expect((await checkOf()).premiseChecks.map((p) => p.key)).toEqual(keys.slice(1));
    // 監査ログに、請求 id と指摘の鍵が残る（確かめ・取り消しの回数だけ）
    expect(auditRows().map((r) => r.target)).toEqual([...keys, keys[0]].map((k) => `${ID}|${k}`));
  });

  it("確定の指摘・出ていない指摘の鍵は断る（確定の指摘は、確かめただけでは残りから外さない）", async () => {
    const c = await checkOf();
    const confirmed = c.findings.filter((f) => f.params?.conditional !== "1" && f.kind !== "情報不足");
    for (const f of confirmed) expect((await (await route()).POST(post({ key: handPremiseKey(f), outcome: "notApplies" }), params)).status).toBe(400);
    expect((await (await route()).POST(post({ key: "rule:R99:R99.none:", outcome: "notApplies" }), params)).status).toBe(400);
    expect((await (await route()).POST(post({ key: "R01", outcome: "notApplies" }), params)).status).toBe(400);
  });

  it("残せるのは医療事務（事務・ベテラン）。事務長・医師は 403", async () => {
    const key = conditionalKeysOf(await checkOf())[0];
    for (const [role, status] of [["veteran", 200], ["manager", 403], ["doctor", 403], ["clerk", 200]] as const) {
      instance.getAuth().switchRole(owner, role);
      expect([role, (await (await route()).POST(post({ key, outcome: "notApplies" }), params)).status]).toEqual([role, status]);
    }
  });

  // データで動く点検（G05・G09）の条件つきは、マスター（RESEMEN_MASTER_DIR）があるときだけ出る
  it.runIf(hasMasters)("見本の K5（G05）・K13（G09）の条件つきも、確かめると残りの数え方から外れる", async () => {
    const me = instance.getAuth().register("premise_kozoka", "すずき", "password123");
    const clerkId = instance.clerkIdOf(me);
    const rows = () => instance.runAs(me, () => instance.getApp().ukeSummary(clerkId));
    instance.runAs(me, () => ["kokuhoren.UKE", "kozoka.UKE"].forEach((f) => instance.getApp().importUke(clerkId, f)));
    for (const prefix of ["K5", "K13"]) {
      const id = rows().find((r) => r.claimId.split("-")[0] === prefix)!.claimId;
      const keys = conditionalKeysOf(instance.runAs(me, () => instance.getApp().ukeCheck(id, clerkId)) as Check);
      expect([prefix, keys.length > 0, keys.every((k) => k.startsWith("data:"))]).toEqual([prefix, true, true]);
      for (const key of keys) instance.runAs(me, () => instance.getApp().savePremiseCheck(id, clerkId, key, "notApplies"));
      const r = rows().find((x) => x.claimId === id)!;
      expect([prefix, r.conditionalChecked, r.open]).toEqual([prefix, r.conditional, othersOf(r) > 0]);
    }
  });
});
