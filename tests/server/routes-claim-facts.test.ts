// 請求ごとに確かめた事実のルート（GET・POST /api/claims/[claimId]/facts）。実際のルート（app/api/**/route.ts）を呼び、
// 残した答えで、取り込んだレセプトの点検（ukeCheck）の判定が変わることを確かめる。AI は呼ばない
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { resolveRevision } from "../../src/engine/revisions";
import type { ClaimContext, Finding } from "../../src/engine/types";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import type { UkeFile } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";
import { claimId, dateIn, day, month, YM } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");
let owner: User;
let cookie: string;

const C = resolveRevision(YM).consts;
const VISIT = C.visitKubun[0];
const OUSHIN = C.oushin.kubun;
/** 取り込む請求：5 日と 15 日は訪問診療料と往診料の両方（往診料の翌日の訪問診療料はない）、12〜15 日は同じ週に訪問診療料が 4 回 */
const ID = "U1-1";
/** 同じ患者の、次の月の請求 */
const NEXT = "U2-1";
const url = `/api/claims/${ID}/facts`;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-claim-facts-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("claim_facts_owner", "やまだ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
  const r = base.receipts[0];
  const file: UkeFile = {
    ...base,
    receipts: [
      {
        ...r,
        claimId: "A1",
        patient: { ...r.patient, name: "架空 梅子", birth: "19480808", insurer: { number: "06139991", symbol: "77", no: "601" } },
        lines: [
          { kubun: VISIT, count: 5, dates: [5, 12, 13, 14, 15].map(day) },
          { kubun: OUSHIN, count: 2, dates: [day(5), day(15)] },
        ],
        comments: [],
      },
    ],
  };
  // 同じ患者の、次の月の請求（別のファイル）。管理料の行があり、居住の場所を聞かれる
  const next: UkeFile = { ...base, receipts: [{ ...file.receipts[0], claimId: "B1", yearMonth: month(1), lines: [{ kubun: VISIT, count: 1, dates: [dateIn(1, 5)] }, { kubun: "C002_2NI1", count: 1, dates: [dateIn(1, 5)] }] }] };
  instance.runAs(owner, () => {
    const a = instance.getApp();
    expect(a.uploadUke(instance.clerkIdOf(owner), writeUke(file)).filter((u) => u.uploaded).flatMap((u) => u.receipts.map((x) => x.claimId))).toEqual([ID]);
    expect(a.uploadUke(instance.clerkIdOf(owner), writeUke(next)).filter((u) => u.uploaded).flatMap((u) => u.receipts.map((x) => x.claimId))).toEqual([ID, NEXT]);
  });
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const get = (u: string, c: string | null) => new Request(`http://localhost${u}`, { headers: c ? { cookie: c } : {} });
const post = (u: string, c: string | null, body: unknown) => new Request(`http://localhost${u}`, { method: "POST", headers: { ...(c ? { cookie: c } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ claimId: id }) });
const routes = () => import("../../app/api/claims/[claimId]/facts/route");
const setRole = (role: Role) => instance.getAuth().switchRole(owner, role);
/** 事実を 1 つ残す（応答の状態を返す） */
const save = async (fact: Record<string, unknown>, id = ID) => (await routes()).POST(post(`/api/claims/${id}/facts`, cookie, { fact }), params(id));
const fact = (key: string, value: unknown, date: string | null = null) => ({ key, date, value, source: "カルテ" });
/** 患者ごとの事実を 1 つ残す（POST /api/patients/[claimId]/facts。応答の状態を返す） */
const savePatient = async (key: string, value: unknown, id = ID) =>
  (await import("../../app/api/patients/[claimId]/facts/route")).POST(post(`/api/patients/${id}/facts`, cookie, { fact: { key, value, source: "カルテ", validUntil: null } }), params(id));
/** 取り込んだレセプトの点検のうち、そのルールの情報不足（項目と日付）と指摘（種類） */
function check(ruleId: string, id = ID) {
  const c = instance.runAs(owner, () => instance.getApp().ukeCheck(id)) as { missing: Finding[]; findings: Finding[] };
  return {
    missing: c.missing.filter((f) => f.ruleId === ruleId && f.missing!.field !== "chartRecord").map((f) => `${f.missing!.field}@${f.missing!.date ?? ""}:${f.missing!.target}`),
    findings: c.findings.filter((f) => f.ruleId === ruleId).map((f) => f.messageKey),
  };
}

describe("請求ごとに確かめた事実のルート", () => {
  it("未ログインは 401、事務長は 403、取り込んでいない請求は 404", async () => {
    const { GET, POST } = await routes();
    expect((await GET(get(url, null), params(ID))).status).toBe(401);
    expect((await POST(post(url, null, {}), params(ID))).status).toBe(401);
    setRole("manager");
    expect((await GET(get(url, cookie), params(ID))).status).toBe(403);
    expect((await save(fact("sameDaySeparate", true, day(5)))).status).toBe(403);
    setRole("clerk");
    expect((await GET(get("/api/claims/U9-9/facts", cookie), params("U9-9"))).status).toBe(404);
    expect((await save(fact("sameDaySeparate", true, day(5)), "U9-9")).status).toBe(404);
    expect((await GET(get("/api/claims/x/facts", cookie), params("../K3"))).status).toBe(400);
  });

  it("診療年月の外の日付・日付のない日付ごとの事実・型の違う値・知らない項目は 400。何も残らない", async () => {
    setRole("clerk");
    const bad = [
      fact("sameDayOushinAfterVisit", true, dateIn(1, 5)),
      fact("sameDayOushinAfterVisit", true, dateIn(-1, 5)),
      fact("sameDayOushinAfterVisit", true, `${YM}-32`),
      fact("sameDayOushinAfterVisit", true, null),
      fact("sameDayOushinAfterVisit", true, `${YM.replace("-", "/")}/05`),
      fact("sameDayOushinAfterVisit", "true", day(5)),
      fact("contactDocProvided", "はい"),
      fact("contactDocProvided", 1),
      fact("contactDocProvided", true, day(5)),
      fact("residence", true),
      fact("residence", "病院"),
      fact("careLevel", 3),
      fact("visitsComplete", true),
      { ...fact("contactDocProvided", true), source: "なんとなく" },
      { ...fact("contactDocProvided", true), checkedBy: "院長" },
    ];
    for (const f of bad) expect([JSON.stringify(f), (await save(f)).status]).toEqual([JSON.stringify(f), 400]);
    const res = await (await routes()).GET(get(url, cookie), params(ID));
    expect([res.status, (await res.json()).facts]).toEqual([200, []]);
  });

  it("同じ日の訪問診療料と往診料：日付つきで残すと、その日の判定だけが変わる（偽・真それぞれ）。別の日の答えは効かない", async () => {
    setRole("clerk");
    const [d5, d15] = [day(5), day(15)];
    // はじめは、両方の日について「訪問診療のあとの往診か」を聞かれる
    expect(check("R10")).toEqual({ missing: [`sameDayOushinAfterVisit@${d5}:clerk`, `sameDayOushinAfterVisit@${d15}:clerk`], findings: [] });

    // 5 日は「あとの往診ではない」：次に、その日が別々の診療かを聞かれる。15 日は聞かれたまま
    expect((await save(fact("sameDayOushinAfterVisit", false, d5))).status).toBe(200);
    expect(check("R10")).toEqual({ missing: [`sameDaySeparate@${d5}:clerk`, `sameDayOushinAfterVisit@${d15}:clerk`], findings: [] });
    // 5 日は別々の診療：その日の往診料は立てられない（要件不足）。15 日は聞かれたまま
    expect((await save(fact("sameDaySeparate", true, d5))).status).toBe(200);
    expect(check("R10")).toEqual({ missing: [`sameDayOushinAfterVisit@${d15}:clerk`], findings: ["R10.oushin_not_after_visit"] });

    // 15 日は「あとの往診」：往診料は立ち、訪問診療料の側の文書の提供を聞かれる
    expect((await save(fact("sameDayOushinAfterVisit", true, d15))).status).toBe(200);
    // 5 日の確定した指摘は、15 日の確認が残っていても出る（1 つの不明でほかの判定を止めない：反証 round-28）
    expect(check("R10")).toEqual({ missing: ["contactDocProvided@:clerk"], findings: ["R10.oushin_not_after_visit"] });
    // 文書を提供していない：15 日の訪問診療料が要件不足。5 日の指摘も出る
    // 文書の提供は患者ごとの事実（design.md §6-1）：請求ごとの入口では残せず、患者ごとの入口で残す
    expect((await save(fact("contactDocProvided", false))).status).toBe(400);
    expect((await savePatient("contactDocProvided", false)).status).toBe(200);
    expect(check("R10")).toEqual({ missing: [], findings: ["R10.oushin_not_after_visit", "R10.same_day_as_visit"] });
    // 直す（最新の 1 件を使う）：提供している → 15 日の指摘が消える
    expect((await savePatient("contactDocProvided", true)).status).toBe(200);
    expect(check("R10")).toEqual({ missing: [], findings: ["R10.oushin_not_after_visit"] });
    // 5 日を直す：1 回の診療だった → 背反に変わる
    expect((await save(fact("sameDaySeparate", false, d5))).status).toBe(200);
    expect(check("R10")).toEqual({ missing: [], findings: ["R10.same_encounter"] });

    // 一覧：項目と日付ごとに最新の 1 件。確かめた人はセッションの本人
    const list = (await (await (await routes()).GET(get(url, cookie), params(ID))).json()) as { yearMonth: string; facts: Record<string, unknown>[] };
    expect(list.yearMonth).toBe(YM);
    expect(list.facts.map((f) => [f.key, f.date, f.value, f.target])).toEqual([
      ["sameDayOushinAfterVisit", d5, false, "clerk"],
      ["sameDayOushinAfterVisit", d15, true, "clerk"],
      ["sameDaySeparate", d5, false, "clerk"],
    ]);
    expect(list.facts.every((f) => f.checkedBy === instance.clerkIdOf(owner) && f.source === "カルテ")).toBe(true);
  });

  it("医師あての事実：医療事務は残せない（403）。医師の役割なら残せ、判定が変わる。医師は医療事務あての事実を残せない", async () => {
    const me = instance.clerkIdOf(owner);
    // 週 4 回の訪問診療料（R13）：別表第七に当たらないと確かめると、急性増悪か（医師あて）を聞かれる
    instance.runAs(owner, () => instance.getApp().savePatientFact(ID, me, { key: "table7", value: false, source: "カルテ", validUntil: null }));
    expect(check("R13")).toEqual({ missing: ["acuteExacerbation@:doctor"], findings: [] });
    setRole("clerk");
    for (const f of [fact("acuteExacerbation", true), fact("rxLongPsychotropic", true, day(12)), fact("mainDisease", "架空の主病"), fact("deathPlace", "在宅")]) expect([f.key, (await save(f)).status]).toEqual([f.key, 403]);
    setRole("veteran");
    expect((await save(fact("acuteExacerbation", true))).status).toBe(403);
    expect(check("R13")).toEqual({ missing: ["acuteExacerbation@:doctor"], findings: [] });

    setRole("doctor");
    expect((await save(fact("dischargeJointGuidance", true))).status).toBe(403);
    expect((await save(fact("acuteExacerbation", false))).status).toBe(200);
    expect(check("R13")).toEqual({ missing: [], findings: ["R13.over_three_a_week"] });
    expect((await save(fact("acuteExacerbation", true))).status).toBe(200);
    expect(check("R13")).toEqual({ missing: [], findings: [] });

    // その日の処方が長期処方に当たるか（医師あて・日付ごと）：残した日の処方箋料だけ、判定が変わる
    const rx = (c: ClaimContext): ClaimContext => ({
      ...c,
      recordsKnown: true,
      events: [12, 13].map((n) => ({ type: "prescription" as const, date: day(n), oralKinds: 3, days: 28, psychotropic: null })),
      lines: [{ kubun: C.rx.other, count: 2, dates: [day(12), day(13)] }],
      comments: [],
      commentsKnown: false,
    });
    const r07 = () => {
      const fs = evaluate(rx(instance.runAs(owner, () => instance.getApp().caseOf(ID)))).findings.filter((f) => f.ruleId === "R07");
      return fs.map((f) => (f.missing ? `${f.missing.field}@${f.missing.date}:${f.missing.target}` : f.messageKey));
    };
    expect(r07()).toEqual([`rxLongPsychotropic@${day(12)}:doctor`, `rxLongPsychotropic@${day(13)}:doctor`]);
    expect((await save(fact("rxLongPsychotropic", true, day(12)))).status).toBe(200);
    expect(r07()).toEqual(["R07.use_long_psychotropic", `rxLongPsychotropic@${day(13)}:doctor`]);
    expect((await save(fact("rxLongPsychotropic", false, day(12)))).status).toBe(200);
    expect(r07()).toEqual([`rxLongPsychotropic@${day(13)}:doctor`]);
    expect((await save(fact("mainDisease", "　架空の主病　"))).status).toBe(200);
    expect(instance.runAs(owner, () => instance.getApp().caseOf(ID)).facts.mainDisease).toEqual({ known: true, value: "架空の主病" });
  });

  it("残していない請求の事実は変わらない。監査ログの対象は請求 id と項目だけで、値・氏名は入らない", async () => {
    setRole("clerk");
    const k1 = JSON.parse(readFileSync(path.join(repo, "fixtures", "cases", "K1.json"), "utf8")) as ClaimContext;
    const facts = instance.runAs(owner, () => instance.getApp().caseOf(claimId("K1"))).facts;
    for (const key of ["sameDaySeparate", "sameDayOushinAfterVisit", "rxLongPsychotropic", "contactDocProvided", "acuteExacerbation", "mainDisease", "residence"] as const) expect([key, facts[key]]).toEqual([key, k1.facts[key]]);
    const rows = instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((r) => r.action === "POST /api/claims/[claimId]/facts");
    expect(new Set(rows.filter((r) => r.result === "ok").map((r) => r.target))).toEqual(
      new Set([`${ID} sameDayOushinAfterVisit`, `${ID} sameDaySeparate`, `${ID} acuteExacerbation`, `${ID} rxLongPsychotropic`, `${ID} mainDisease`]),
    );
    expect(rows.filter((r) => r.result === "denied").length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/架空|06139991|やまだ/);
  });

  it("患者ごとに残した事実（居住の場所など 4 つ）は、同じ患者の別の月の請求にも効く。請求ごとに残した古い行は使わない", async () => {
    setRole("clerk");
    const residenceOf = (id: string) => instance.runAs(owner, () => instance.getApp().caseOf(id)).facts.residence;
    // 次の月の請求：管理料の行があるので、居住の場所を聞かれる（聞くのは住まいの種別。design.md §18-2 C-494）
    expect(check("R16", NEXT).missing).toEqual(["residenceType@:clerk"]);
    expect([residenceOf(ID), residenceOf(NEXT)]).toEqual([{ known: false }, { known: false }]);
    // 形の違う値・期限つきは 400
    expect((await savePatient("residence", "病院")).status).toBe(400);
    expect((await savePatient("residence", true)).status).toBe(400);
    expect((await savePatient("emergencyEligible", "居宅")).status).toBe(400);
    // 今月の請求から残す → 同じ患者の、次の月の請求でも聞かれなくなる
    expect((await savePatient("residence", "居宅")).status).toBe(200);
    expect([residenceOf(ID), residenceOf(NEXT)]).toEqual([{ known: true, value: "居宅" }, { known: true, value: "居宅" }]);
    expect(check("R16", NEXT).missing).toEqual([]);
    // 次の月の請求から直しても、今月の請求に効く（患者に付く）
    expect((await savePatient("residence", "施設入居等", NEXT)).status).toBe(200);
    expect(residenceOf(ID)).toEqual({ known: true, value: "施設入居等" });
    for (const key of ["emergencyEligible", "comprehensiveCare"] as const) {
      expect((await savePatient(key, true)).status).toBe(200);
      expect([key, instance.runAs(owner, () => instance.getApp().caseOf(NEXT)).facts[key]]).toEqual([key, { known: true, value: true }]);
    }
    // 前の版で請求ごとに残した行（claim_facts に居住の場所）が DB にあっても、判定にも一覧にも出ない
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(instance.tenantPaths(owner.tenantId).dbFile);
    db.prepare("INSERT INTO claim_facts (claim_id, key, date, value, source, checked_by, checked_at) VALUES (?, 'residence', '', ?, 'カルテ', ?, ?)").run(NEXT, JSON.stringify("居宅"), instance.clerkIdOf(owner), new Date().toISOString());
    db.close();
    expect(residenceOf(NEXT)).toEqual({ known: true, value: "施設入居等" });
    expect(instance.runAs(owner, () => instance.getApp().claimFacts(NEXT)).facts).toEqual([]);
  });
});
