// 段 16：背反の組の院内の知識（design.md §14・§14-5 の完了条件）を、ルートを通して確かめる。G05 はマスター（RESEMEN_MASTER_DIR）があるときだけ動くので、
// 対象の組（§13 で「その他」と答えて決まらなくなった往診料×訪問診療料。X-123）を使う確かめは、マスターがあるときだけ。
// 取り込んだのは実在の形の請求（同梱の合成の患者でない。UKE を書き換えてアップロードしたもの）
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import { haihanKey } from "../../src/generic/haihan";
import { localKey } from "../../src/generic/local-pair";
import type { GenericView } from "../../src/generic/view";
import { applyEvent, createKnowledge, readKnowledge } from "../../src/lifecycle/store";
import type { KnowledgeMeta } from "../../src/lifecycle/types";
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

const rev = resolveRevision(YM);
const VISIT = rev.consts.visitKubun[0];
const OUSHIN = rev.consts.oushin.kubun;
const [VISIT_CODE, OUSHIN_CODE] = [rev.codes[VISIT].primary, rev.codes[OUSHIN].primary];
const [A, B] = [OUSHIN_CODE, VISIT_CODE].sort();
const ID = "U1-1";
const masters = process.env.RESEMEN_MASTER_DIR ? path.join(process.env.RESEMEN_MASTER_DIR, "masters.db") : "";
const hasMasters = masters !== "" && existsSync(masters);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-local-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("local_owner", "やまだ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
  const r = base.receipts[0];
  const file: UkeFile = {
    ...base,
    receipts: [{ ...r, claimId: "A1", patient: { ...r.patient, name: "架空 梅子", birth: "19480808", insurer: { number: "06139992", symbol: "77", no: "603" } }, lines: [{ kubun: VISIT, count: 2, dates: [day(5), day(15)] }, { kubun: OUSHIN, count: 2, dates: [day(5), day(15)] }], comments: [] }],
  };
  instance.runAs(owner, () => expect(instance.getApp().uploadUke(instance.clerkIdOf(owner), writeUke(file)).filter((u) => u.uploaded).flatMap((u) => u.receipts.map((x) => x.claimId))).toEqual([ID]));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const get = (u: string) => new Request(`http://localhost${u}`, { headers: { cookie } });
const post = (u: string, body: unknown) => new Request(`http://localhost${u}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ claimId: id }) });
const factRoutes = () => import("../../app/api/claims/[claimId]/facts/route");
const knowledgeRoutes = () => import("../../app/api/knowledge/route");
const setRole = (role: Role) => instance.getAuth().switchRole(owner, role);
const save = async (key: string, value: unknown, date: string | null) => (await factRoutes()).POST(post(`/api/claims/${ID}/facts`, { fact: { key, date, value, source: "カルテ" } }), params(ID));
const facts = async () => ((await (await (await factRoutes()).GET(get(`/api/claims/${ID}/facts`), params(ID))).json()) as { facts: Record<string, unknown>[] }).facts;
const createPair = async (over: Record<string, unknown> = {}) => (await knowledgeRoutes()).POST(post("/api/knowledge", { action: "pair", claimId: ID, a: A, b: B, tani: 1, polarity: "allow", basis: "審査で通った", condition: "急変の往診で、時間が分かれている", ...over }));
const check = () => instance.runAs(owner, () => instance.getApp().ukeCheck(ID, instance.clerkIdOf(owner))) as { generic?: GenericView };
const g05 = () => (check().generic?.findings ?? []).filter((f) => f.check === "G05" && f.codes.some((c) => c.code === OUSHIN_CODE) && f.codes.some((c) => c.code === VISIT_CODE));
const meta = (id: string) => readKnowledge(instance.runAs(owner, () => instance.getApp().store), id) as KnowledgeMeta;
/** 本人の処理件数を n 件にする（完了した問題を直接入れる。レベルは config/levels.json の Lv.4＝100 件、Lv.5＝180 件） */
function setCount(n: number) {
  const db = new Database(instance.tenantPaths(owner.tenantId).dbFile);
  try {
    const clerkId = instance.clerkIdOf(owner);
    db.prepare("DELETE FROM questions WHERE id LIKE 'lv-%'").run();
    const ins = db.prepare("INSERT INTO questions (id, clerk_id, claim_id, data) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < n; i++) ins.run(`lv-${i}`, clerkId, ID, JSON.stringify({ id: `lv-${i}`, clerkId, claimId: ID, phase: "完了", finishedAt: `2026-10-01T09:00:${String(i % 60).padStart(2, "0")}+09:00`, mode: "通常", correct: true, drafts: [] }));
  } finally {
    db.close();
  }
}

describe("作る入口と押した事実（マスターがなくても確かめられること）", () => {
  it("形の違う key・知識のない key の押した事実は 400。医師の役割は 403", async () => {
    setRole("clerk");
    expect((await save(`local:local/none@aaaaaaaaaaaa:${A}:${B}`, true, day(5))).status).toBe(400);
    expect((await save(`local:local/none@aaaaaaaaaaaa:${B}:${A}`, true, day(5))).status).toBe(400);
    setRole("doctor");
    expect((await save(`local:local/none@aaaaaaaaaaaa:${A}:${B}`, true, day(5))).status).toBe(403);
    setRole("clerk");
  });
  it.skipIf(hasMasters)("（マスターがないとき）G05 が動かないので、どの組も作れない（400）", async () => {
    expect((await createPair()).status).toBe(400);
  });
});

describe.skipIf(!hasMasters)("（マスターがあるとき）design.md §14-5 の完了条件", () => {
  let K = "";
  it("§13 の問いが未決の組は対象でない（作るのは 400）。「その他」と答えて決まらなくなると作れる。allow＋返戻は 400、同じ組・同じ扱いの 2 つ目は 409", async () => {
    setRole("clerk");
    expect((await createPair()).status).toBe(400);
    const KEY = haihanKey("HX-01", OUSHIN_CODE, VISIT_CODE);
    for (const d of [day(5), day(15)]) expect((await save(KEY, "その他", d)).status).toBe(200);
    expect(g05().map((f) => f.localPair)).toEqual([{ a: A, b: B, tani: 1 }]);
    expect((await createPair({ basis: "返戻・査定された" })).status).toBe(400);
    const res = await createPair();
    expect(res.status).toBe(200);
    K = ((await res.json()) as { id: string }).id;
    expect([meta(K).status, meta(K).layer, meta(K).match]).toEqual(["未検証", "院内", { codePair: { a: A, b: B, tani: 1 } }]);
    expect((await createPair({ condition: "別の文" })).status).toBe(409);
    // 未検証のあいだは判断の軸にしない（id だけ添える）
    expect(g05()[0].local?.mode).toBe("unverified");
    setRole("veteran");
    expect((await (await knowledgeRoutes()).POST(post("/api/knowledge", { action: "verify", id: K, approve: true }))).status).toBe(200);
    expect(meta(K).status).toBe("承認済み");
  });

  it("Lv.4 の本人：「確かめてください」にヒントとして条件が出て、ボタンはない。Lv.4 からの押した事実は 400", async () => {
    setRole("clerk");
    setCount(100);
    const f = g05();
    expect([f.length, f[0].local?.mode, f[0].local?.press]).toEqual([1, "hint", []]);
    expect(f[0].local?.texts[0]).toContain("急変の往診で、時間が分かれている");
    expect((await save(localKey(K, meta(K).rev, A, B), true, day(5))).status).toBe(400);
  });

  it("Lv.5 の本人：条件とボタン。押すとその請求のその組（その日）だけ出なくなり、点検の範囲に数と id。押さない日は出る", async () => {
    setRole("clerk");
    setCount(180);
    const key = localKey(K, meta(K).rev, A, B);
    expect(g05()[0].local?.press).toEqual([{ key, date: day(5) }, { key, date: day(15) }]);
    // 照らし：同一月の扱いの日付なし・別の日（組の行がない日）は 400
    expect((await save(key, true, null)).status).toBe(400);
    expect((await save(key, true, day(6))).status).toBe(400);
    expect((await save(key, true, day(5))).status).toBe(200);
    const left = g05();
    expect(left.map((f) => f.local?.press)).toEqual([[{ key, date: day(15) }]]);
    expect(check().generic?.scope?.notDone).toContain(`院内の知識で、この請求も条件に当たると確かめたので出していない：1 件（${K}）`);
    // 押した事実の一覧には、押した人の役割だけ（名前・id は返さない）
    const pressed = (await facts()).filter((x) => x.key === key);
    expect(pressed.map((x) => [x.date, x.checkedByRole, x.checkedByName, x.checkedBy])).toEqual([[day(5), "clerk", "", ""]]);
  });

  it("時計が進まないまま、要再検証 → 承認済みに戻すと、前の押下は効かない（押し直すと効く。round-43 C-200）", async () => {
    const store = instance.runAs(owner, () => instance.getApp().store);
    const T = instance.runAs(owner, () => instance.getApp().now());
    const since = meta(K).status_since;
    applyEvent(store, K, { type: "TRIGGER", trigger: "localRevision" }, T, { trigger: "localRevision", codePair: { a: A, b: B, tani: 1 }, changes: ["テスト"] });
    applyEvent(store, K, { type: "RECHECK_PASS", via: "veteran", officialKeys: [] }, T);
    // 承認済みに戻った時刻は前と同じ（時計が進んでいない）
    expect([meta(K).status, meta(K).status_since]).toEqual(["承認済み", since]);
    const key = localKey(K, meta(K).rev, A, B);
    expect(g05().map((f) => f.local?.press)).toEqual([[{ key, date: day(5) }, { key, date: day(15) }]]);
    expect((await save(key, true, day(5))).status).toBe(200);
    expect(g05().map((f) => f.local?.press)).toEqual([[{ key, date: day(15) }]]);
  });

  it("押した「条件に当たる」は取り消せる（取り消しの行を足し、監査ログに残す。知識は要再検証にしない。round-43 codex #4）", async () => {
    const key = localKey(K, meta(K).rev, A, B);
    expect((await save(key, false, day(5))).status).toBe(200);
    expect(g05().map((f) => f.local?.press)).toEqual([[{ key, date: day(5) }, { key, date: day(15) }]]);
    expect(meta(K).status).toBe("承認済み");
    expect((await facts()).filter((x) => x.key === key)).toEqual([]);
    // 押していない日の取り消しは 400。医師の役割は 403
    expect((await save(key, false, day(5))).status).toBe(400);
    setRole("doctor");
    expect((await save(key, false, day(5))).status).toBe(403);
    setRole("clerk");
    const audit = instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((r) => r.action === "POST /api/claims/[claimId]/facts" && r.result === "ok" && r.target === `${ID} local:${K}@${meta(K).rev}`);
    expect(audit.length).toBeGreaterThanOrEqual(3);
    // 押し直す（次のテストが使う）
    expect((await save(key, true, day(5))).status).toBe(200);
  });

  it("添えた知識に USED が出る（同じ請求・同じ知識は 1 日 1 回）。算定プレビューでは出さない", () => {
    check();
    const now = instance.runAs(owner, () => instance.getApp().now());
    expect([meta(K).last_used_at, meta(K).last_hit_at]).toEqual([now, now]);
    const db = new Database(instance.tenantPaths(owner.tenantId).dbFile, { readonly: true });
    try {
      check();
      expect(db.prepare("SELECT count(*) AS n FROM local_used WHERE claim_id = ? AND knowledge_id = ?").get(ID, K)).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("返戻：「この請求のこの組が返戻・査定された」で、その組の知識だけ要再検証になり、その請求の押した事実は取り消す。ほかの組の知識は変わらない。押した事実がなくても出す（C-182）", async () => {
    const store = instance.runAs(owner, () => instance.getApp().store);
    // ほかの組の承認済みの allow（この請求にない組）
    const other = createKnowledge(store, { layer: "院内", slug: "pair-other", summary: "ほかの組", body: "ほかの組", source: { type: "手動", ref: "test" }, polarity: "allow", matchApprox: true, conditionNote: "根拠：その他。ほかの組", match: { codePair: { a: A, b: "160000310", tani: 1 } } }, instance.runAs(owner, () => instance.getApp().now()));
    applyEvent(store, other.id, { type: "VERIFY_APPROVE" }, instance.runAs(owner, () => instance.getApp().now()));
    const returns = (check() as { localReturns?: { a: string; b: string; tani: number; ids: string[] }[] }).localReturns;
    expect(returns).toEqual([{ a: A, b: B, tani: 1, ids: [K] }]);
    const route = (await import("../../app/api/claims/[claimId]/local-return/route")).POST;
    setRole("doctor");
    expect((await route(post(`/api/claims/${ID}/local-return`, { a: A, b: B, tani: 1 }), params(ID))).status).toBe(403);
    setRole("clerk");
    expect((await route(post(`/api/claims/${ID}/local-return`, { a: A, b: "160000310", tani: 1 }), params(ID))).status).toBe(400);
    expect((await route(post(`/api/claims/${ID}/local-return`, { a: A, b: B, tani: 1 }), params(ID))).status).toBe(200);
    expect([meta(K).status, meta(K).history.at(-1)?.event, meta(K).history.at(-1)?.basis]).toEqual(["要再検証", "TRIGGER{localReturn}", { trigger: "localReturn", claimId: ID, codePair: { a: A, b: B, tani: 1 } }]);
    expect(meta(other.id).status).toBe("承認済み");
    expect((await facts()).filter((x) => String(x.key).startsWith("local:"))).toEqual([]);
    // 要再検証のあいだは判断の軸にしない（Lv.5 でもボタンは出ず、両方の日が出る）
    expect(g05().map((f) => [f.local, f.text.includes("5")])).toEqual([[undefined, true]]);
    const audit = instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((r) => r.action === "POST /api/claims/[claimId]/local-return" && r.result === "ok");
    expect(audit.map((r) => r.target).sort()).toEqual([`${ID} ${A}:${B}:1`, `${ID} local:${K}@${meta(K).rev}`].sort());
    for (const r of audit) expect((r.target ?? "").length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(audit)).not.toMatch(/急変の往診|架空|やまだ/);
  });
});
