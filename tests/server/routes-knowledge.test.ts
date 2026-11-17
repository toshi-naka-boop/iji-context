// 知識・会議・通知・メンター同士の問い・本人情報・開発用のルート（app/api/**/route.ts）を実際に呼んで確かめる。LLM は呼ばない
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import type { Role } from "../../src/server/roles";
import { month } from "../helpers/period";

let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-knowledge-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});
beforeEach(() => resetLimits());

const auth = () => instance.getAuth();
const cookieOf = (u: User) => `resemen_session=${auth().createSession(u.id).token}`;
const get = (url: string, cookie: string | null) => new Request(`http://localhost${url}`, { headers: cookie ? { cookie } : {} });
const post = (url: string, cookie: string | null, body?: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const switchTo = async (cookie: string, role: Role) => (await import("../../app/api/auth/role/route")).POST(post("/api/auth/role", cookie, { role }));
const auditOf = (u: User) => instance.runAs(u, () => instance.getApp().audit.list(500)).reverse();
const knowledge = () => import("../../app/api/knowledge/route");

describe("知識", () => {
  it("未ログインは 401", async () => {
    const { GET, POST } = await knowledge();
    expect((await GET(get("/api/knowledge", null))).status).toBe(401);
    expect((await POST(post("/api/knowledge", null, { action: "empathy", id: "system/r01" }))).status).toBe(401);
    expect((await GET(get("/api/knowledge", "resemen_session=nonexistent"))).status).toBe(401);
  });

  it("閲覧（一覧・検証キュー）はどのロールでも 200", async () => {
    const { GET } = await knowledge();
    const owner = auth().register("kn_view", "えつらん", "password123");
    const cookie = cookieOf(owner);
    for (const role of ["clerk", "veteran", "manager", "doctor"] as const) {
      if (role !== "clerk") expect((await switchTo(cookie, role)).status).toBe(200);
      const list = await GET(get("/api/knowledge", cookie));
      expect(list.status, role).toBe(200);
      expect(((await list.json()) as { id: string }[]).some((k) => k.id === "system/r01")).toBe(true);
      expect((await GET(get("/api/knowledge?view=queue", cookie))).status, role).toBe(200);
    }
    // 知らない view・知らない項目は断る
    const bad = await GET(get("/api/knowledge?view=all", cookie));
    expect(bad.status).toBe(400);
    expect((await bad.json()).fields).toEqual(["view"]);
    expect((await GET(get("/api/knowledge?layer=local", cookie))).status).toBe(400);
  });

  it("検証は事務ロールで 403、ベテランなら通る。名前は受け取らず、監査ログにセッションの本人が残る", async () => {
    const { GET, POST } = await knowledge();
    const owner = auth().register("kn_verify", "けんしょう", "password123");
    const cookie = cookieOf(owner);
    const send = (body: unknown) => POST(post("/api/knowledge", cookie, body));

    // 提案と共感は事務ロールでもできる
    const proposed = await send({ action: "propose", summary: "訪問日の確認", body: "訪問日はカルテの日付と照合する" });
    expect(proposed.status).toBe(200);
    const { id, status } = (await proposed.json()) as { id: string; status: string };
    expect(id).toMatch(/^local\/proposal-\d{4}$/);
    expect(status).toBe("未検証");
    const other = ((await (await send({ action: "propose", summary: "摘要の書き方", body: "理由を摘要に書く", relatesTo: "system/r11" })).json()) as { id: string }).id;
    expect((await send({ action: "empathy", id })).status).toBe(200);

    // 事務ロールの検証は断り、状態は変わらない
    const denied = await send({ action: "verify", id, approve: true });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain("ベテラン");
    const statusOf = async (k: string) => ((await (await GET(get("/api/knowledge", cookie))).json()) as { id: string; status: string }[]).find((x) => x.id === k)?.status;
    expect(await statusOf(id)).toBe("未検証");

    expect((await switchTo(cookie, "veteran")).status).toBe(200);
    // 画面から名前を送っても受け取らない（知らない項目として断る）
    const named = await send({ action: "verify", id, approve: true, verifiedBy: "院長" });
    expect(named.status).toBe(400);
    expect((await named.json()).fields).toEqual(["verifiedBy"]);
    const ok = await send({ action: "verify", id, approve: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("承認済み");
    const rejected = await send({ action: "verify", id: other, approve: false, reason: "重複" });
    expect(((await rejected.json()) as { status: string; retired_reason: string })).toMatchObject({ status: "保管", retired_reason: "重複" });
    // 検証済みの知識をもう一度検証すると、業務上の拒否（409）。ない知識は 404
    expect((await send({ action: "verify", id, approve: true })).status).toBe(409);
    expect((await send({ action: "verify", id: "local/proposal-9999", approve: true })).status).toBe(404);

    // 監査ログ：操作ごとに 1 行。対象は知識の id だけで、本文・理由は入らない。誰がしたかは、セッションの本人
    const rows = auditOf(owner);
    expect(rows.map((r) => [r.action, r.target, r.result, r.role])).toEqual([
      ["POST /api/knowledge", null, "ok", "clerk"],
      ["POST /api/knowledge", "system/r11", "ok", "clerk"],
      ["POST /api/knowledge", id, "ok", "clerk"],
      ["POST /api/knowledge", id, "denied", "clerk"],
      ["POST /api/auth/role", "veteran", "ok", "clerk"],
      ["POST /api/knowledge", null, "invalid", "veteran"],
      ["POST /api/knowledge", id, "ok", "veteran"],
      ["POST /api/knowledge", other, "ok", "veteran"],
      ["POST /api/knowledge", id, "rejected", "veteran"],
      ["POST /api/knowledge", "local/proposal-9999", "rejected", "veteran"],
    ]);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([owner.id]));
    expect(JSON.stringify(rows)).not.toContain("重複");
    expect(JSON.stringify(rows)).not.toContain("けんしょう");
  });

  it("スキーマに合わない入力は 400 と項目名。知識の id にパスの区切りを含むものは断る", async () => {
    const { POST } = await knowledge();
    const owner = auth().register("kn_schema", "すきーま", "password123");
    const cookie = cookieOf(owner);
    await switchTo(cookie, "veteran");
    const fieldsOf = async (body: unknown) => {
      const r = await POST(post("/api/knowledge", cookie, body));
      expect(r.status, JSON.stringify(body)).toBe(400);
      return ((await r.json()) as { fields: string[] }).fields;
    };
    expect(await fieldsOf({ action: "verify", id: "system/r01", approve: "yes" })).toEqual(["approve"]);
    expect(await fieldsOf({ action: "delete", id: "system/r01" })).toEqual(["action"]);
    expect(await fieldsOf({ action: "propose", summary: "あ", body: "い".repeat(4001) })).toEqual(["body"]);
    expect(await fieldsOf({ action: "verify", id: "system/r01", approve: false, reason: "あ".repeat(501) })).toEqual(["reason"]);
    for (const bad of ["../../auth", "local/../../auth", "local/a/b", "local\\a", "/etc/passwd", "local/", "unknown/r01", "local/A_b", "local/a.tmp-1"]) {
      expect(await fieldsOf({ action: "verify", id: bad, approve: true }), bad).toEqual(["id"]);
      expect(await fieldsOf({ action: "empathy", id: bad }), bad).toEqual(["id"]);
    }
    expect(await fieldsOf({ action: "propose", summary: "あ", body: "い", relatesTo: "../x" })).toEqual(["relatesTo"]);
    // 空白だけの提案は、業務処理の文言で断る
    const blank = await POST(post("/api/knowledge", cookie, { action: "propose", summary: " ", body: "い" }));
    expect(blank.status).toBe(400);
    expect((await blank.json()).error).toBe("要約と本文が必要");
  });
});

describe("メンター同士の問い・会議・通知", () => {
  it("ベテラン本人の回答はベテランだけ。問いの id の形を確かめ、回答済みは 409", async () => {
    const answer = (await import("../../app/api/peer/[id]/answer/route")).POST;
    const list = (await import("../../app/api/peer/route")).GET;
    const owner = auth().register("peer_owner", "といあわせ", "password123");
    const cookie = cookieOf(owner);
    const id = instance.runAs(owner, () => instance.getApp().peerToHuman("new1", "看取りの月の区分は？").queued);
    const send = (pid: string, body: unknown) => answer(post(`/api/peer/${pid}/answer`, cookie, body), params(pid));

    expect((await list(get("/api/peer", cookie))).status).toBe(200);
    expect((await send(id, { answer: "訪問の回数で決める" })).status).toBe(403);
    await switchTo(cookie, "veteran");
    expect((await send("../../auth", { answer: "x" })).status).toBe(400);
    expect((await (await send(id, { answer: "x", answeredBy: "院長" })).json()).fields).toEqual(["answeredBy"]);
    const blank = await send(id, { answer: "  " });
    expect(blank.status).toBe(400);
    expect((await blank.json()).error).toBe("回答が空");
    const ok = await send(id, { answer: "訪問の回数で決める" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id, knowledgeId: `veteran/esc-${id.toLowerCase()}` });
    expect((await send(id, { answer: "もう一度" })).status).toBe(409);
    expect((await send("P9999", { answer: "x" })).status).toBe(404);
    const rows = auditOf(owner).filter((r) => r.action === "POST /api/peer/[id]/answer");
    expect(rows.map((r) => [r.target, r.result])).toEqual([[id, "denied"], [null, "invalid"], [id, "invalid"], [id, "rejected"], [id, "ok"], [id, "rejected"], ["P9999", "rejected"]]);
    expect(JSON.stringify(rows)).not.toContain("訪問の回数");
  });

  it("問いの一覧：誰が聞いたか（from_clerk）は、ベテランと、その問いを出した本人にだけ返る。問いと回答は全員に返る", async () => {
    const list = (await import("../../app/api/peer/route")).GET;
    type Row = { id: string; question: string; answer: string | null; from_clerk?: string };
    const rowsOf = async (u: User) => (await (await list(get("/api/peer", cookieOf(u)))).json()) as Row[];
    // 持ち主を事務長にしてから、事務 2 人・ベテラン・医師を招待で入れる
    const owner = auth().register("peer_from", "もちぬし", "password123");
    expect((await switchTo(cookieOf(owner), "manager")).status).toBe(200);
    const manager = auth().login("peer_from", "password123")!;
    const join = (login: string, role: Role) => auth().registerWithInvite(login, login, "password123", auth().createInvite(manager, role).code);
    const asker = join("peer_asker", "clerk");
    const another = join("peer_another", "clerk");
    const veteran = join("peer_veteran", "veteran");
    const doctor = join("peer_doctor", "doctor");
    const askerId = instance.clerkIdOf(asker);
    const [open, solved] = instance.runAs(asker, () => [
      instance.getApp().peerToHuman(askerId, "看取りの月の区分は？").queued,
      instance.getApp().peerResolvedByMentor(askerId, "BNP のコメントは？", "R11 の知識による。").id,
    ]);

    // 出した本人とベテランには、誰が聞いたかが返る
    for (const u of [asker, veteran]) {
      expect((await rowsOf(u)).map((r) => [r.id, r.from_clerk]), u.login).toEqual([[open, askerId], [solved, askerId]]);
    }
    // ほかの事務・事務長・医師には、問いと回答は返るが、誰が聞いたかは項目ごと返らない
    for (const u of [another, manager, doctor]) {
      const rows = await rowsOf(u);
      expect(rows.map((r) => [r.id, r.question, r.answer]), u.login).toEqual([[open, "看取りの月の区分は？", null], [solved, "BNP のコメントは？", "R11 の知識による。"]]);
      expect(rows.some((r) => "from_clerk" in r), u.login).toBe(false);
      expect(JSON.stringify(rows), u.login).not.toContain(askerId);
    }
    // ほかの人が出した問いが混ざっても、自分の分にだけ付く
    const anotherId = instance.clerkIdOf(another);
    const mine = instance.runAs(another, () => instance.getApp().peerToHuman(anotherId, "処方箋料は？").queued);
    expect((await rowsOf(another)).map((r) => [r.id, r.from_clerk])).toEqual([[open, undefined], [solved, undefined], [mine, anotherId]]);
  });

  it("議題はベテランと事務長が見られ、回答と整理はベテランだけ", async () => {
    const meeting = await import("../../app/api/meeting/route");
    const answer = (await import("../../app/api/meeting/answer/route")).POST;
    const owner = auth().register("meeting_owner", "かいぎ", "password123");
    const cookie = cookieOf(owner);
    const itemId = "0123456789abcdef";
    expect((await meeting.GET(get("/api/meeting", cookie))).status).toBe(403);
    expect((await meeting.POST(post("/api/meeting", cookie))).status).toBe(403);
    expect((await answer(post("/api/meeting/answer", cookie, { itemId, answer: 1 }))).status).toBe(403);
    await switchTo(cookie, "manager");
    expect((await meeting.GET(get("/api/meeting", cookie))).status).toBe(200);
    expect((await answer(post("/api/meeting/answer", cookie, { itemId, answer: 1 }))).status).toBe(403);
    await switchTo(cookie, "veteran");
    expect((await meeting.GET(get("/api/meeting", cookie))).status).toBe(200);
    expect((await meeting.POST(post("/api/meeting", cookie))).status).toBe(200);
    expect((await (await answer(post("/api/meeting/answer", cookie, { itemId, answer: 5 }))).json()).fields).toEqual(["answer"]);
    expect((await (await answer(post("/api/meeting/answer", cookie, { itemId: "../x", answer: 1 }))).json()).fields).toEqual(["itemId"]);
    expect((await (await answer(post("/api/meeting/answer", cookie, { itemId, answer: 1, answeredBy: "院長" }))).json()).fields).toEqual(["answeredBy"]);
    const rows = auditOf(owner).filter((r) => r.action === "POST /api/meeting/answer");
    // ロールで断ったとき・検証で落ちたときは本文を読んでいないので、対象は残らない（対象が本文にあるルート）
    expect(rows.map((r) => [r.target, r.result, r.role])).toEqual([
      [null, "denied", "clerk"],
      [null, "denied", "manager"],
      [null, "invalid", "veteran"],
      [null, "invalid", "veteran"],
      [null, "invalid", "veteran"],
    ]);
    // 通った回答は、議題の項目の id が対象に残る。ない項目は 404 と文言（定型文の 500 にしない）
    const unknown = await answer(post("/api/meeting/answer", cookie, { itemId, answer: 1 }));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe(`未知の項目: ${itemId}`);
    expect(auditOf(owner).at(-1)).toMatchObject({ action: "POST /api/meeting/answer", target: itemId, userId: owner.id, result: "rejected", status: 404 });
  });

  it("通知の読み取りはベテランだけ。PDF でないものは LLM を呼ぶ前に断る", async () => {
    const notice = (await import("../../app/api/notice/route")).POST;
    const register = (await import("../../app/api/notice/register/route")).POST;
    const owner = auth().register("notice_owner", "つうち", "password123");
    const cookie = cookieOf(owner);
    const b64 = (s: string) => Buffer.from(s, "latin1").toString("base64");
    expect((await notice(post("/api/notice", cookie, { pdfBase64: b64("%PDF-1.7"), fileName: "a.pdf" }))).status).toBe(403);
    await switchTo(cookie, "veteran");
    const notPdf = await notice(post("/api/notice", cookie, { pdfBase64: b64("<html>"), fileName: "a.pdf" }));
    expect(notPdf.status).toBe(400);
    expect((await notPdf.json()).error).toBe("PDF ではない");
    expect((await (await notice(post("/api/notice", cookie, {}))).json()).error).toContain("PDF が空");
    expect((await (await notice(post("/api/notice", cookie, { sample: "yes" }))).json()).fields).toEqual(["sample"]);
    // 5MB の PDF が入る大きさまでは本文を読み、それを超えると 413
    const tooBig = await notice(post("/api/notice", cookie, { pdfBase64: "A".repeat(7_100_000) }));
    expect(tooBig.status).toBe(413);
    // 登録：通知の形を確かめる。ない項目は業務処理の文言で断る
    const empty = { documentType: "増減点連絡書", prefecture: "東京都", items: [] };
    expect((await (await register(post("/api/notice/register", cookie, { notice: { ...empty, items: [{ outcome: "減点" }] }, index: 0, fileName: "a.pdf" }))).json()).fields).toContain("notice.items.0.outcome");
    expect((await (await register(post("/api/notice/register", cookie, { notice: empty, index: -1, fileName: "a.pdf" }))).json()).fields).toEqual(["index"]);
    const none = await register(post("/api/notice/register", cookie, { notice: empty, index: 0, fileName: "a.pdf" }));
    expect(none.status).toBe(400);
    expect((await none.json()).error).toBe("通知に 1 件目の項目がない");
  });

  it("通知の登録：対応づけが済んでいない項目は 400、同じ項目の再登録は 409（どちらも文言つき）。ファイル名は長さと文字を絞る", async () => {
    const register = (await import("../../app/api/notice/register/route")).POST;
    const owner = auth().register("notice_reg", "とうろく", "password123");
    const cookie = cookieOf(owner);
    await switchTo(cookie, "veteran");
    const item = { yearMonth: month(-1), patientName: "架空 六郎", insurerNumber: "01139997", itemName: "BNP", outcome: "査定", reason: "傷病名が「心不全の疑い」のまま、連月で算定されているため" };
    const notice = { documentType: "増減点連絡書", prefecture: "東京都", items: [item, { ...item, itemName: "どの区分にも当たらない項目" }] };
    const send = (index: number, fileName = "a.pdf") => register(post("/api/notice/register", cookie, { notice, index, fileName }));
    // 新しいクリニックには、同じ通知（K6 の査定）から作った地域ルールが最初から入っている → 再登録は 409
    const dup = await send(0);
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toMatch(/^既に存在する知識: regional\/notice-[0-9a-f]{10}$/);
    const unresolved = await send(1);
    expect(unresolved.status).toBe(400);
    expect((await unresolved.json()).error).toContain("対応づけが済んでいない項目は候補にできない");
    // ファイル名（知識の本文に入る）：改行・パスの区切り・100 字超・空は 400
    for (const bad of ["a\n# 見出し.pdf", "../a.pdf", "dir\\a.pdf", "あ".repeat(101), ""]) expect((await (await send(1, bad)).json()).fields, bad).toEqual(["fileName"]);
    const rows = auditOf(owner).filter((r) => r.action === "POST /api/notice/register");
    expect(rows.slice(0, 2).map((r) => [r.result, r.status])).toEqual([["rejected", 409], ["rejected", 400]]);
  });
});

describe("本人のこと・事務長の集計・開発用", () => {
  it("キャラ・伝え方・名前は本人（セッション）のものを変える。本人の id は受け取らない", async () => {
    const character = await import("../../app/api/character/route");
    const name = (await import("../../app/api/clerk/name/route")).POST;
    const me = (await import("../../app/api/me/route")).GET;
    const owner = auth().register("me_owner", "ほんにん", "password123");
    const cookie = cookieOf(owner);
    expect((await character.GET(get("/api/character", null))).status).toBe(401);
    expect(((await (await character.GET(get("/api/character", cookie))).json()) as { chosen: boolean }).chosen).toBe(false);
    expect((await (await character.POST(post("/api/character", cookie, { clerkId: "vet1", characterId: "b" }))).json()).fields).toEqual(["clerkId"]);
    expect((await (await character.POST(post("/api/character", cookie, { style: { preference: "ぶっきらぼうに" } }))).json()).fields).toEqual(["style.preference"]);
    expect((await character.POST(post("/api/character", cookie, { characterId: "zz" }))).status).toBe(404);
    const picked = (await (await character.POST(post("/api/character", cookie, { characterId: "b" }))).json()) as { chosen: boolean; current: { id: string } };
    expect(picked).toMatchObject({ chosen: true, current: { id: "b" } });
    const styled = (await (await character.POST(post("/api/character", cookie, { style: { preference: "結論から短く" } }))).json()) as { style: unknown };
    expect(styled.style).toEqual({ preference: "結論から短く" });

    const badName = await name(post("/api/clerk/name", cookie, { name: "<script>" }));
    expect(badName.status).toBe(400);
    expect((await badName.json()).error).toBe("名前に使えない文字があります");
    expect(await (await name(post("/api/clerk/name", cookie, { name: "トシ" }))).json()).toEqual({ name: "トシ" });
    expect(instance.runAs(owner, () => instance.getApp().clerk("new1"))).toMatchObject({ name: "トシ", character_id: "b" });

    const status = await me(get("/api/me?optIn=1", cookie));
    expect(status.status).toBe(200);
    expect((await status.json()) as object).toHaveProperty("level");
    expect((await me(get("/api/me?optIn=yes", cookie))).status).toBe(400);
    // 名前は監査ログに入らない
    const rows = auditOf(owner);
    expect(rows.filter((r) => r.action === "POST /api/clerk/name").map((r) => [r.target, r.result])).toEqual([[null, "rejected"], [null, "ok"]]);
    expect(JSON.stringify(rows)).not.toContain("トシ");
  });

  it("事務長の集計は事務長だけ", async () => {
    const GET = (await import("../../app/api/manager/route")).GET;
    const owner = auth().register("mgr_owner", "じむちょう", "password123");
    const cookie = cookieOf(owner);
    expect((await GET(get("/api/manager", cookie))).status).toBe(403);
    await switchTo(cookie, "veteran");
    expect((await GET(get("/api/manager", cookie))).status).toBe(403);
    await switchTo(cookie, "manager");
    expect((await GET(get("/api/manager", cookie))).status).toBe(200);
  });

  it("開発用のルートは本番で 404、開発時もログインが要る", async () => {
    const GET = (await import("../../app/api/sdk-check/route")).GET;
    const owner = auth().register("dev_owner", "かいはつ", "password123");
    expect((await GET(get("/api/sdk-check", null))).status).toBe(401);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect((await GET(get("/api/sdk-check", cookieOf(owner)))).status).toBe(404);
      expect((await GET(get("/api/sdk-check", null))).status).toBe(404);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
