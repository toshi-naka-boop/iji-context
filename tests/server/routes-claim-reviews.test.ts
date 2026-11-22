// 段 17g（design.md §14-3「レベルで線を引く」・L-123）：実在用のクリニックでは、取り込んだレセプトの点検で本人が「この請求の点検を確かめた」を押した請求も、
// F10 の処理件数に数える（同じ請求・同じ本人は 1 件）。デモのクリニックは今のまま（練習問題で数える）。線は Lv.5（config/levels.json の 180 件）のまま。
// 「条件に当たる」を実際に押す確かめは G05 が動くとき（マスター〔RESEMEN_MASTER_DIR〕があるとき）だけ。ないときは、レベルの照らしを通ったかを 400 の文で見る
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import { haihanKey } from "../../src/generic/haihan";
import { localKey } from "../../src/generic/local-pair";
import type { GenericView } from "../../src/generic/view";
import { readKnowledge } from "../../src/lifecycle/store";
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

const rev = resolveRevision(YM);
const VISIT = rev.consts.visitKubun[0];
const OUSHIN = rev.consts.oushin.kubun;
const [VISIT_CODE, OUSHIN_CODE] = [rev.codes[VISIT].primary, rev.codes[OUSHIN].primary];
const [A, B] = [OUSHIN_CODE, VISIT_CODE].sort();
const masters = process.env.RESEMEN_MASTER_DIR ? path.join(process.env.RESEMEN_MASTER_DIR, "masters.db") : "";
const hasMasters = masters !== "" && existsSync(masters);

const cookieOf = (u: User) => `resemen_session=${instance.getAuth().createSession(u.id).token}`;
const get = (u: string, cookie: string) => new Request(`http://localhost${u}`, { headers: { cookie } });
const post = (u: string, body: unknown, cookie: string) => new Request(`http://localhost${u}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = (id: string) => ({ params: Promise.resolve({ claimId: id }) });

/** 往診料と訪問診療料が同じ日にある請求を 2 件、実在の形で取り込む（同梱の合成の患者でない）。shas に取り込んだファイルのハッシュを残す */
const shas = new Map<string, string>();
function upload(owner: User): string[] {
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
  const r = base.receipts[0];
  const receipt = (claimId: string, no: string) => ({ ...r, claimId, patient: { ...r.patient, name: "架空 梅子", birth: "19480808", insurer: { number: "06139992", symbol: "77", no } }, lines: [{ kubun: VISIT, count: 2, dates: [day(5), day(15)] }, { kubun: OUSHIN, count: 2, dates: [day(5), day(15)] }], comments: [] });
  const file: UkeFile = { ...base, receipts: [receipt("A1", "603"), receipt("A2", "604")] };
  const buf = writeUke(file);
  shas.set(owner.id, createHash("sha256").update(buf).digest("hex"));
  return instance.runAs(owner, () => instance.getApp().uploadUke(instance.clerkIdOf(owner), buf).filter((u) => u.uploaded).flatMap((u) => u.receipts.map((x) => x.claimId)));
}
/** 本人の練習問題の件数を n 件にする（完了した問題を直接入れる） */
function setCount(owner: User, clerkId: string, claimId: string, n: number) {
  const db = new Database(instance.tenantPaths(owner.tenantId).dbFile);
  try {
    db.prepare("DELETE FROM questions WHERE id LIKE ?").run(`lv-${clerkId}-%`);
    const ins = db.prepare("INSERT INTO questions (id, clerk_id, claim_id, data) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < n; i++) ins.run(`lv-${clerkId}-${i}`, clerkId, claimId, JSON.stringify({ id: `lv-${clerkId}-${i}`, clerkId, claimId, phase: "完了", finishedAt: `2026-10-01T09:00:${String(i % 60).padStart(2, "0")}+09:00`, mode: "通常", correct: true, drafts: [] }));
  } finally {
    db.close();
  }
}
const reviewRows = (owner: User) => {
  const db = new Database(instance.tenantPaths(owner.tenantId).dbFile, { readonly: true });
  try {
    return db.prepare("SELECT claim_id, clerk_id, reviewed_at FROM claim_reviews ORDER BY claim_id, clerk_id").all() as { claim_id: string; clerk_id: string; reviewed_at: string }[];
  } finally {
    db.close();
  }
};
const clearReviews = (owner: User) => {
  const db = new Database(instance.tenantPaths(owner.tenantId).dbFile);
  try {
    db.prepare("DELETE FROM claim_reviews").run();
  } finally {
    db.close();
  }
};
const review = async (id: string, cookie: string) => (await import("../../app/api/uke/claims/[claimId]/reviewed/route")).POST(post(`/api/uke/claims/${id}/reviewed`, undefined, cookie), params(id));
const me = async (cookie: string) => (await (await (await import("../../app/api/me/route")).GET(get("/api/me", cookie))).json()) as { level: number; count: number; streak: number };
const checkRoute = async (id: string, cookie: string) => (await import("../../app/api/uke/claims/[claimId]/check/route")).GET(get(`/api/uke/claims/${id}/check`, cookie), params(id));
const saveFact = async (id: string, key: string, value: unknown, date: string | null, cookie: string) => (await import("../../app/api/claims/[claimId]/facts/route")).POST(post(`/api/claims/${id}/facts`, { fact: { key, date, value, source: "カルテ" } }, cookie), params(id));

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-reviewed-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

describe("実在用のクリニック：取り込んだ請求の点検を確かめた件数も F10 の処理件数に数える", () => {
  let owner: User;
  let cookie: string;
  let ids: string[] = [];
  const setRole = (role: Role) => instance.getAuth().switchRole(owner, role);
  beforeAll(() => {
    owner = instance.getAuth().register("reviewed_owner", "やまだ", "password123", "real");
    cookie = cookieOf(owner);
    ids = upload(owner);
    expect(ids.length).toBe(2);
    setRole("clerk");
  });

  it("取り込んだ請求 1 件を確かめると本人の件数が 1 増え、同じ請求をもう一度確かめても増えない。請求・本人・押した日が残る", async () => {
    setCount(owner, instance.clerkIdOf(owner), ids[0], 3);
    expect((await me(cookie)).count).toBe(3);
    // 押す前は、点検の応答に「まだ確かめていない」（null）が載る
    expect(((await (await checkRoute(ids[0], cookie)).json()) as { reviewed?: unknown }).reviewed).toBeNull();
    const first = await review(ids[0], cookie);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ added: true, count: 4 });
    expect((await me(cookie)).count).toBe(4);
    const again = await review(ids[0], cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ added: false, count: 4 });
    expect((await me(cookie)).count).toBe(4);
    const rows = reviewRows(owner);
    expect(rows.map((r) => [r.claim_id, r.clerk_id])).toEqual([[ids[0], instance.clerkIdOf(owner)]]);
    expect(rows[0].reviewed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(((await (await checkRoute(ids[0], cookie)).json()) as { reviewed?: unknown }).reviewed).toEqual({ at: rows[0].reviewed_at });
    // 監査ログに、押した操作が請求 id で残る
    const audit = instance.runAs(owner, () => instance.getApp().audit.list(100)).filter((r) => r.action === "POST /api/uke/claims/[claimId]/reviewed" && r.result === "ok");
    expect(audit.map((r) => r.target)).toEqual([ids[0], ids[0]]);
  });

  it("取り込んでいない請求は確かめられない（件数は増えない）", async () => {
    const before = (await me(cookie)).count;
    expect((await review("NOPE-1", cookie)).status).toBeGreaterThanOrEqual(400);
    expect((await me(cookie)).count).toBe(before);
  });

  describe.skipIf(!hasMasters)("（マスターがあるとき）線は Lv.5 のまま：確かめた件数を足して 180 件に届くと「条件に当たる」が押せ、179 件では 400", () => {
    let K = "";
    it("承認済みの allow の院内の知識を用意する（1 人のクリニックで、役割を切り替えて）", async () => {
      const KEY = haihanKey("HX-01", OUSHIN_CODE, VISIT_CODE);
      for (const id of ids) for (const d of [day(5), day(15)]) expect((await saveFact(id, KEY, "その他", d, cookie)).status).toBe(200);
      const res = await (await import("../../app/api/knowledge/pair/route")).POST(post("/api/knowledge/pair", { claimId: ids[0], a: A, b: B, tani: 1, polarity: "allow", basis: "審査で通った", condition: "急変の往診で、時間が分かれている" }, cookie));
      expect(res.status).toBe(200);
      K = ((await res.json()) as { id: string }).id;
      setRole("veteran");
      expect((await (await import("../../app/api/knowledge/route")).POST(post("/api/knowledge", { action: "verify", id: K, approve: true }, cookie))).status).toBe(200);
      setRole("clerk");
    });
    it("練習問題 178 件＋確かめた 1 件＝179 件では 400「Lv.5 から残せます」。もう 1 件確かめて 180 件になると押せる", async () => {
      clearReviews(owner);
      setCount(owner, instance.clerkIdOf(owner), ids[0], 178);
      const meta = readKnowledge(instance.runAs(owner, () => instance.getApp().store), K) as KnowledgeMeta;
      const key = localKey(K, meta.rev, A, B);
      expect((await review(ids[0], cookie)).status).toBe(200);
      expect(await me(cookie)).toMatchObject({ count: 179, level: 4 });
      const no = await saveFact(ids[0], key, true, day(5), cookie);
      expect(no.status).toBe(400);
      expect(((await no.json()) as { error: string }).error).toContain("Lv.5 から残せます");
      // Lv.4 のあいだは、点検にボタン（押す項目）が出ない
      const g05 = () => (((instance.runAs(owner, () => instance.getApp().ukeCheck(ids[0], instance.clerkIdOf(owner))) as { generic?: GenericView }).generic?.findings ?? []).filter((f) => f.check === "G05" && f.localPair?.a === A && f.localPair.b === B));
      expect(g05()[0].local?.press).toEqual([]);
      expect((await review(ids[1], cookie)).status).toBe(200);
      expect(await me(cookie)).toMatchObject({ count: 180, level: 5 });
      expect(g05()[0].local?.press).toEqual([{ key, date: day(5) }, { key, date: day(15) }]);
      expect((await saveFact(ids[0], key, true, day(5), cookie)).status).toBe(200);
    });
  });

  it.skipIf(hasMasters)("（マスターがないとき）179 件ではレベルの照らしで 400「Lv.5 から残せます」、180 件ではレベルの照らしを通る（知識がないので別の 400）", async () => {
    clearReviews(owner);
    setCount(owner, instance.clerkIdOf(owner), ids[0], 178);
    const key = `local:local/none@aaaaaaaaaaaa:${A}:${B}`;
    expect((await review(ids[0], cookie)).status).toBe(200);
    expect(await me(cookie)).toMatchObject({ count: 179, level: 4 });
    const no = await saveFact(ids[0], key, true, day(5), cookie);
    expect([no.status, ((await no.json()) as { error: string }).error]).toEqual([400, "「条件に当たる」は、Lv.5 から残せます"]);
    expect((await review(ids[1], cookie)).status).toBe(200);
    expect(await me(cookie)).toMatchObject({ count: 180, level: 5 });
    const passed = await saveFact(ids[0], key, true, day(5), cookie);
    expect(passed.status).toBe(400);
    expect(((await passed.json()) as { error: string }).error).not.toContain("Lv.5");
  });

  it("別の本人が同じ請求を確かめると、その本人の件数が増え、持ち主の件数は変わらない。他人の件数・レベル・確かめた記録は画面に出ない（FR-16）", async () => {
    const ownerBefore = await me(cookie);
    const { code } = instance.getAuth().createInvite(owner, "clerk");
    const mate = instance.getAuth().registerWithInvite("reviewed_mate", "すずき", "password123", code);
    const mateCookie = cookieOf(mate);
    expect((await me(mateCookie)).count).toBe(0);
    // 持ち主が確かめた請求でも、別の本人の点検の応答は「まだ確かめていない」
    expect(((await (await checkRoute(ids[0], mateCookie)).json()) as { reviewed?: unknown }).reviewed).toBeNull();
    const res = await review(ids[0], mateCookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ added: true, count: 1 });
    expect(Object.keys(body).sort()).toEqual(["added", "at", "count", "level"]);
    expect((await me(mateCookie)).count).toBe(1);
    expect(await me(cookie)).toEqual(ownerBefore);
    // 点検の応答・本人の件数の応答に、他人の id・名前・件数は載らない
    const ownerView = JSON.stringify(await (await checkRoute(ids[0], cookie)).json());
    const mateView = JSON.stringify(await (await checkRoute(ids[0], mateCookie)).json());
    for (const v of [ownerView, JSON.stringify(await me(cookie))]) expect(v).not.toMatch(new RegExp(`${mate.id}|すずき`));
    for (const v of [mateView, JSON.stringify(await me(mateCookie))]) expect(v).not.toMatch(new RegExp(`${instance.clerkIdOf(owner)}|${owner.id}|やまだ`));
    expect(reviewRows(owner).filter((r) => r.claim_id === ids[0]).map((r) => r.clerk_id).sort()).toEqual([instance.clerkIdOf(owner), instance.clerkIdOf(mate)].sort());
  });

  it("取り込んだファイルを消すと、その請求の確かめた記録も消える（design.md §11-11「消す」）", () => {
    expect(reviewRows(owner).length).toBeGreaterThan(0);
    instance.runAs(owner, () => instance.getApp().deleteUpload(shas.get(owner.id)!));
    expect(reviewRows(owner)).toEqual([]);
  });
});

describe("デモのクリニック：「確かめた」で件数が増えず、練習問題の件数の数え方が変わらない", () => {
  it("押しても 400 で記録が残らず、件数は練習問題の数のまま。点検の応答にボタンの項目（reviewed）が載らない", async () => {
    const owner = instance.getAuth().register("reviewed_demo", "たなか", "password123", "demo");
    const cookie = cookieOf(owner);
    const ids = upload(owner);
    setCount(owner, instance.clerkIdOf(owner), ids[0], 5);
    expect((await me(cookie)).count).toBe(5);
    expect("reviewed" in ((await (await checkRoute(ids[0], cookie)).json()) as object)).toBe(false);
    const res = await review(ids[0], cookie);
    expect(res.status).toBe(400);
    expect((await me(cookie)).count).toBe(5);
    expect(reviewRows(owner)).toEqual([]);
    setCount(owner, instance.clerkIdOf(owner), ids[0], 6);
    expect((await me(cookie)).count).toBe(6);
  });
});
