// 医師に確かめてほしい項目（GET・POST /api/doctor/facts）。実際のルート（app/api/**/route.ts）を呼び、
// 医師が答えを残すと取り込んだレセプトの点検（ukeCheck）の判定が変わること、「その他」「判定不能」は事実を不明のまま残すことを確かめる。AI は呼ばない
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import type { Finding } from "../../src/engine/types";
import { validateQuery } from "../../src/query/doctor-query";
import type { DoctorFactItem } from "../../src/server/app/doctor-facts";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import type { UkeFile } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";
import { day, YM } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");
let owner: User;
let cookie: string;
let bytes: Buffer;

const VISIT = resolveRevision(YM).consts.visitKubun[0];
/** 取り込む請求：12〜15 日の同じ週に訪問診療料が 4 回（R13：別表第七に当たるか → 急性増悪か、の順に医師に聞く） */
const ID = "U1-1";

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-doctor-facts-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("doctor_facts_owner", "やまだ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
  const r = base.receipts[0];
  const file: UkeFile = {
    ...base,
    receipts: [{ ...r, claimId: "A1", patient: { ...r.patient, name: "架空 桃子", birth: "19480808", insurer: { number: "06139991", symbol: "77", no: "701" } }, lines: [{ kubun: VISIT, count: 4, dates: [12, 13, 14, 15].map(day) }], comments: [] }],
  };
  bytes = writeUke(file);
  instance.runAs(owner, () => expect(instance.getApp().uploadUke(instance.clerkIdOf(owner), bytes).filter((u) => u.uploaded).flatMap((u) => u.receipts.map((x) => x.claimId))).toEqual([ID]));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const get = (u: string, c: string | null) => new Request(`http://localhost${u}`, { headers: c ? { cookie: c } : {} });
const post = (u: string, c: string | null, body: unknown) => new Request(`http://localhost${u}`, { method: "POST", headers: { ...(c ? { cookie: c } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ claimId: id }) });
const routes = () => import("../../app/api/doctor/facts/route");
const setRole = (role: Role) => instance.getAuth().switchRole(owner, role);
/** 一覧（応答の本文の文字と、その請求の項目） */
async function list() {
  const res = await (await routes()).GET(get("/api/doctor/facts", cookie));
  const text = await res.text();
  return { status: res.status, text, items: res.status === 200 ? (JSON.parse(text) as DoctorFactItem[]).filter((i) => i.claimId === ID) : [] };
}
/** 決められなかった答え（その他・判定不能）を残す */
const note = async (body: Record<string, unknown>) => (await (await routes()).POST(post("/api/doctor/facts", cookie, body))).status;
/** 決まった答えを、事実の入口に残す（画面と同じ道） */
const savePatient = async (key: string, value: unknown) =>
  (await (await import("../../app/api/patients/[claimId]/facts/route")).POST(post(`/api/patients/${ID}/facts`, cookie, { fact: { key, value, source: "医師に確認", validUntil: null } }), params(ID))).status;
const saveClaim = async (key: string, value: unknown, date: string | null = null) =>
  (await (await import("../../app/api/claims/[claimId]/facts/route")).POST(post(`/api/claims/${ID}/facts`, cookie, { fact: { key, date, value, source: "医師に確認" } }), params(ID))).status;
/** 取り込んだレセプトの点検のうち、R13 の情報不足（項目と宛先）と指摘（種類） */
function r13() {
  const c = instance.runAs(owner, () => instance.getApp().ukeCheck(ID)) as { missing: Finding[]; findings: Finding[] };
  return {
    missing: c.missing.filter((f) => f.ruleId === "R13" && f.missing!.field !== "chartRecord").map((f) => `${f.missing!.field}:${f.missing!.target}`),
    findings: c.findings.filter((f) => f.ruleId === "R13").map((f) => f.messageKey),
  };
}
const factOf = (key: "table7" | "acuteExacerbation") => instance.runAs(owner, () => instance.getApp().caseOf(ID)).facts[key];
const rowsOf = (table: string) => {
  const db = new Database(instance.tenantPaths(owner.tenantId).dbFile, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
};

describe("医師に確かめてほしい項目", () => {
  it("未ログインは 401。医療事務・ベテラン・事務長は、一覧も記録も 403（医師の役割だけ）", async () => {
    const { GET, POST } = await routes();
    expect((await GET(get("/api/doctor/facts", null))).status).toBe(401);
    expect((await POST(post("/api/doctor/facts", null, {}))).status).toBe(401);
    for (const role of ["clerk", "veteran", "manager"] as const) {
      setRole(role);
      expect([role, (await list()).status]).toEqual([role, 403]);
      expect([role, await note({ claimId: ID, key: "table7", date: null, option: "判定不能" })]).toEqual([role, 403]);
    }
    expect(rowsOf("doctor_fact_notes")).toEqual([]);
  });

  it("一覧は、点検で医師あてに出ている情報不足。選択肢に必ず「その他」「判定不能」があり、問いと選択肢は点数・金額に触れず、患者の氏名・番号は返らない", async () => {
    setRole("doctor");
    const { status, text, items } = await list();
    expect(status).toBe(200);
    // 週 4 回の訪問診療料：まず、別表第七に当たるか（患者ごとの事実）を聞かれる。点検の側の情報不足と同じもの
    expect(r13()).toEqual({ missing: ["table7:doctor"], findings: [] });
    expect(items.map((i) => [i.field, i.date, i.scope, i.input, i.yearMonth, i.note])).toEqual([["table7", null, "patient", "boolean", YM, null]]);
    expect(items[0].options).toEqual(["はい", "いいえ", "その他", "判定不能"]);
    // 全部の項目（同梱の症例の分も）について、医師確認の決まり（src/query/doctor-query.ts の検査）を通る：その他・判定不能がある、点数・金額・請求に触れない、誘導しない
    const all = JSON.parse(text) as DoctorFactItem[];
    expect(all.length).toBeGreaterThan(0);
    for (const i of all) {
      expect([i.field, i.options.slice(-2)]).toEqual([i.field, ["その他", "判定不能"]]);
      const errors = validateQuery({ question: i.question, indicators: [{ source: "点検", text: i.question }], options: i.options });
      // 文字で答える項目（主病）は、臨床的な選択肢が「記入する」の 1 つだけ（記入は誘導にならない）。それ以外の違反はない
      expect([i.field, errors.filter((e) => !(i.input === "text" && e.startsWith("②臨床的な選択肢")))]).toEqual([i.field, []]);
      expect(i.question).not.toMatch(/点|円/);
    }
    // 誰の話かを医師が判断できる表示（採点 r3 医療事務課長 #1）：氏名・性別・生年月日・請求の傷病名と、状態の一覧の要旨。保険者番号・記号番号は返さない
    expect(items[0].patient).toMatchObject({ name: "架空 桃子", birth: "19480808" });
    expect(items[0].stateSummary?.text).toContain("別表第七");
    expect(items[0].stateSummary?.href).toMatch(/^https:\/\/www\.mhlw\.go\.jp\//);
    expect(text).not.toMatch(/06139991|701"/);
  });

  it("「判定不能」「その他」は事実を不明のまま残す（その他は自由記述つき）。判定は変わらない。一覧にない項目・形の違う入力は残せない", async () => {
    setRole("doctor");
    const item = { claimId: ID, key: "table7", date: null };
    // 形の違う入力は 400、一覧にない項目・請求は 404
    expect(await note({ ...item, option: "はい" })).toBe(400);
    expect(await note({ ...item, option: "その他" })).toBe(400);
    expect(await note({ ...item, option: "その他", freeText: "　" })).toBe(400);
    expect(await note({ ...item, option: "判定不能", freeText: "書かない" })).toBe(400);
    expect(await note({ ...item, option: "判定不能", answeredBy: "院長" })).toBe(400);
    expect(await note({ ...item, key: "../x", option: "判定不能" })).toBe(400);
    expect(await note({ ...item, key: "acuteExacerbation", option: "判定不能" })).toBe(404);
    expect(await note({ ...item, date: day(12), option: "判定不能" })).toBe(404);
    expect(await note({ ...item, claimId: "U9-9", option: "判定不能" })).toBe(404);
    expect(rowsOf("doctor_fact_notes")).toEqual([]);

    // 判定不能：記録は残るが、事実は不明のまま。点検は同じことを聞き続け、一覧にも残る（前の回答つき）
    expect(await note({ ...item, option: "判定不能" })).toBe(200);
    expect(factOf("table7")).toEqual({ known: false });
    expect(r13()).toEqual({ missing: ["table7:doctor"], findings: [] });
    expect((await list()).items.map((i) => [i.field, i.note?.option, i.note?.freeText])).toEqual([["table7", "判定不能", null]]);

    // その他：自由記述が残る。事実は不明のまま
    expect(await note({ ...item, option: "その他", freeText: "　紹介元に照会中　" })).toBe(200);
    expect(factOf("table7")).toEqual({ known: false });
    expect(r13()).toEqual({ missing: ["table7:doctor"], findings: [] });
    expect((await list()).items.map((i) => [i.field, i.note?.option, i.note?.freeText])).toEqual([["table7", "その他", "紹介元に照会中"]]);
    expect(rowsOf("doctor_fact_notes").map((r) => [r.claim_id, r.key, r.date, r.option, r.free_text, r.answered_by])).toEqual([
      [ID, "table7", "", "判定不能", null, instance.clerkIdOf(owner)],
      [ID, "table7", "", "その他", "紹介元に照会中", instance.clerkIdOf(owner)],
    ]);
    // 事実の表には、何も入っていない
    expect(rowsOf("patient_facts")).toEqual([]);
    expect(rowsOf("claim_facts")).toEqual([]);
  });

  it("医師が答えを残すと、判定が変わる：患者ごとの事実（別表第七）→ 次の問い（急性増悪。請求ごとの事実）→ 指摘。答えた項目は一覧から消える", async () => {
    setRole("doctor");
    // 医師は、医療事務あての項目を残せない
    expect(await savePatient("residence", "居宅")).toBe(403);
    // 別表第七に当たらない：次に、急性増悪か（請求ごとの事実）を聞かれる
    expect(await savePatient("table7", false)).toBe(200);
    expect(factOf("table7")).toEqual({ known: true, value: false });
    expect(r13()).toEqual({ missing: ["acuteExacerbation:doctor"], findings: [] });
    expect((await list()).items.map((i) => [i.field, i.scope, i.input, i.options])).toEqual([["acuteExacerbation", "claim", "boolean", ["はい", "いいえ", "その他", "判定不能"]]]);
    // 急性増悪ではない：週 3 回を超える訪問診療料の指摘が出る（判定が変わる）。聞くことはなくなる
    expect(await saveClaim("acuteExacerbation", false)).toBe(200);
    expect(r13()).toEqual({ missing: [], findings: ["R13.over_three_a_week"] });
    expect((await list()).items).toEqual([]);
    // 直す：急性増悪だった → 指摘が消える
    expect(await saveClaim("acuteExacerbation", true)).toBe(200);
    expect(r13()).toEqual({ missing: [], findings: [] });

    // 監査ログ：対象は請求 id と項目だけ。答え・自由記述・氏名は入らない
    const rows = instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((r) => r.action === "POST /api/doctor/facts");
    expect(new Set(rows.filter((r) => r.result === "ok").map((r) => r.target))).toEqual(new Set([`${ID} table7`]));
    expect(JSON.stringify(instance.runAs(owner, () => instance.getApp().audit.list(500)))).not.toMatch(/紹介元|判定不能|架空|やまだ/);
  });

  it("取り込んだファイルを消すと、その請求の「その他」「判定不能」の記録も消える", async () => {
    expect(rowsOf("doctor_fact_notes").length).toBe(2);
    setRole("manager");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const res = await (await import("../../app/api/uke/uploads/[sha256]/route")).DELETE(new Request(`http://localhost/api/uke/uploads/${sha256}`, { method: "DELETE", headers: { cookie } }), { params: Promise.resolve({ sha256 }) });
    expect(res.status).toBe(200);
    expect(rowsOf("doctor_fact_notes")).toEqual([]);
    expect(rowsOf("claim_facts")).toEqual([]);
  });
});
