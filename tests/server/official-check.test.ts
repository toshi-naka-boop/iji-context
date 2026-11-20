// design.md §11-3・§11-8 の完了条件 7：公的文書の条件に当たるかを人が確かめる。K6 の地域知識を、ルート（app/api/**/route.ts）を実際に呼んで通す
// 承認 → SJ-133 に「当たる」→ 欄が「矛盾の恐れ（人が確かめた）」→ 会議の整理 → 議題に ④ の確かめ直し → 責任者の回答。LLM は呼ばない
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyEvent, listKnowledge, readKnowledge } from "../../src/lifecycle/store";
import { docKey } from "../../src/official/match";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import type { Role } from "../../src/server/roles";
import { claimId } from "../helpers/period";
import { makeDoc } from "../official/helpers";

let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-official-check-"));
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
const post = (url: string, cookie: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

/** 1 人で始めたクリニック（K6 の地域知識が未検証で入っている）と、その人としてルートを呼ぶ道具 */
async function clinic(login: string, name: string) {
  const owner = auth().register(login, name, "password123");
  const cookie = `resemen_session=${auth().createSession(owner.id).token}`;
  const as = <T>(fn: (app: ReturnType<typeof instance.getApp>) => T) => instance.runAs(owner, () => fn(instance.getApp()));
  const switchTo = async (role: Role) => expect((await (await import("../../app/api/auth/role/route")).POST(post("/api/auth/role", cookie, { role }))).status).toBe(200);
  const ruleId = as((app) => app.knowledgeList().find((k) => k.layer === "地域")!.id);
  const call = async (kind: "applies" | "not-applies", body: unknown, id = ruleId) => {
    const { POST } = kind === "applies" ? await import("../../app/api/knowledge/[id]/official-check/applies/route") : await import("../../app/api/knowledge/[id]/official-check/not-applies/route");
    return POST(post(`/api/knowledge/${encodeURIComponent(id)}/official-check/${kind}`, cookie, body), { params: Promise.resolve({ id }) });
  };
  const knowledgePost = async (body: unknown) => (await import("../../app/api/knowledge/route")).POST(post("/api/knowledge", cookie, body));
  const meeting = async () => expect((await (await import("../../app/api/meeting/route")).POST(post("/api/meeting", cookie))).status).toBe(200);
  const answer = async (itemId: string, n: 1 | 2, freeText?: string) => (await import("../../app/api/meeting/answer/route")).POST(post("/api/meeting/answer", cookie, { itemId, answer: n, ...(freeText ? { freeText } : {}) }));
  const meta = () => as((app) => readKnowledge(app.store, ruleId)!);
  /** K6 のローカルルール欄に出る、その知識の行（請求を開き直して読む） */
  const column = () => as((app) => app.localRulesOf(app.start(instance.clerkIdOf(owner), claimId("K6")).id).find((r) => r.id === ruleId));
  const docs = as((app) => app.deps.official!.docs);
  const keyOf = (id: string) => docKey(docs.find((d) => d.id === id)!);
  const recheck = () => as((app) => app.agenda().items.find((i) => i.kind === "recheck" && i.knowledgeId === ruleId));
  const audit = () => as((app) => app.audit.list(500)).reverse().filter((r) => r.action.includes("official-check")).map((r) => [r.action.split("/").at(-1), r.target, r.result, r.status, r.role]);
  return { owner: owner as User, cookie, as, switchTo, ruleId, call, knowledgePost, meeting, answer, meta, column, docs, keyOf, recheck, audit };
}
const events = (m: { history: { event: string }[] }) => m.history.map((h) => h.event);

describe("K6 の地域知識：公的文書の条件に当たるかを確かめる（完了条件 7）", () => {
  it("承認 → SJ-133 に「当たる」→ 欄が「矛盾の恐れ（人が確かめた）」→ 会議の整理で ④ の確かめ直し →「今も正しい」で承認済みに戻り、確認済みになって次の整理で ④ が出ない", async () => {
    const c = await clinic("oc_pass", "たしかめ");
    await c.switchTo("veteran");
    expect((await c.knowledgePost({ action: "verify", id: c.ruleId, approve: true })).status).toBe(200);

    // 確認がない間は今までどおり：どの文書も関連あり・未照合。確かめられるのは、向きがあり条件の注記を持つ文書だけ（SJ-286 は「条件つき」）
    const before = c.column()!;
    expect(before.official).toMatchObject({ verdict: "関連あり・未照合", humanChecked: false, canCheck: true, notApplying: [] });
    expect(before.official.checks.map((x) => x.docId)).toEqual(["SJ-133", "SJ-154", "SJ-210", "SJ-319", "SJ-89"]);
    const sj133 = before.official.checks.find((x) => x.docId === "SJ-133")!;
    expect(sj133).toEqual({ docId: "SJ-133", key: c.keyOf("SJ-133"), condition: "傷病名が心不全（確定病名）で、連月で算定する場合", check: null });
    // 画面に並べる 3 つ：文書の条件（上）・知識の match を言葉にしたもの・知識の注記
    expect(before.official.matchText).toBe("BNPを算定している・審査支払機関が支払基金・東京都");
    expect(before.official.ruleNote).toContain("通知の理由：");

    // 事務の役割：「当たらない」は 403。古い鍵での「当たる」は 409（読み直しを促す）。どちらも何も残さない
    await c.switchTo("clerk");
    const denied = await c.call("not-applies", { docId: "SJ-133", key: sj133.key });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain("ベテラン");
    const stale = await c.call("applies", { docId: "SJ-133", key: "SJ-133#00000000" });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe("文書が更新されました。読み直してください");
    expect(c.meta().official_checks).toBeUndefined();

    // 事務の役割で「当たる」：状態は変えず、欄が「矛盾の恐れ（人が確かめた）」になる。確かめた人と日が出る
    const ok = await c.call("applies", { docId: "SJ-133", key: sj133.key });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: c.ruleId, status: "承認済み", docId: "SJ-133", key: sj133.key, applies: true });
    const now = c.as((app) => app.now());
    expect(c.meta()).toMatchObject({ status: "承認済み", official_seen: [], official_checks: { [sj133.key]: { applies: true, by: instance.clerkIdOf(c.owner), at: now } } });
    expect(c.meta().history.at(-1)).toMatchObject({ event: "OFFICIAL_CHECK{applies}", actor: "clerk", from: "承認済み", to: "承認済み", basis: { officialIds: [sj133.key] } });
    const checked = c.column()!;
    expect(checked.official).toMatchObject({ verdict: "矛盾の恐れ", humanChecked: true });
    expect(checked.official.docs.find((d) => d.id === "SJ-133")?.verdict).toBe("矛盾の恐れ");
    expect(checked.official.checks.find((x) => x.docId === "SJ-133")?.check).toEqual({ applies: true, by: "たしかめ", at: now.slice(0, 10) });

    // SJ-319（疑いへの連月は認めない）に「当たる」と確かめると、向きが同じなので整合（人が確かめた）。まとめは危ない側のまま
    expect((await c.call("applies", { docId: "SJ-319", key: c.keyOf("SJ-319") })).status).toBe(200);
    const both = c.column()!;
    expect(both.official.verdict).toBe("矛盾の恐れ");
    expect(both.official.docs.filter((d) => d.id === "SJ-133" || d.id === "SJ-319").map((d) => [d.id, d.verdict])).toEqual([["SJ-133", "矛盾の恐れ"], ["SJ-319", "整合"]]);
    expect(both.official.checks.find((x) => x.docId === "SJ-319")?.check).toMatchObject({ applies: true, by: "たしかめ" });

    // 会議の整理（時計に依らない）→ ④ が発火して要再検証になり、議題の確かめ直しに文書の要旨とリンクが載る。自動では停止しない
    await c.switchTo("veteran");
    await c.meeting();
    expect(c.meta().status).toBe("要再検証");
    expect(c.meta().history.at(-1)).toMatchObject({ event: "TRIGGER{official}", basis: { trigger: "official", officialIds: [sj133.key] } });
    const item = c.recheck()!;
    const doc = c.docs.find((d) => d.id === "SJ-133")!;
    expect(item.reason).toMatchObject({ kind: "recheck", trigger: "official", official: [{ id: "SJ-133", url: doc.url, summary: doc.summary, stance: "認める", seen: false }] });
    expect((item.reason as { official: unknown[] }).official).toHaveLength(1);
    expect(item.choices.map((x) => x.label)).toEqual(expect.arrayContaining(["その他", "判定不能"]));
    // 要再検証の知識も、状態つきで欄に出る（メンターは使わない）。確認もできる
    expect(c.column()).toMatchObject({ status: "要再検証", usedByMentor: false, official: { verdict: "矛盾の恐れ", canCheck: true } });

    // 「今も正しい」→ 承認済みに戻り、その文書は確認済み（official_seen）になる。次の整理で ④ は出ない
    const answered = await c.answer(item.itemId, 1);
    expect(await answered.json()).toEqual({ status: "applied" });
    expect(c.meta()).toMatchObject({ status: "承認済み", official_seen: [sj133.key] });
    await c.meeting();
    expect(c.meta().status).toBe("承認済み");
    expect(events(c.meta()).filter((e) => e === "TRIGGER{official}")).toHaveLength(1);
    expect(c.recheck()).toBeUndefined();
    // 欄の表示は確認済みかどうかを見ない（矛盾の恐れと出続ける）
    expect(c.column()!.official).toMatchObject({ verdict: "矛盾の恐れ", humanChecked: true });

    // 責任者の「当たらない」：その文書は結果から外れ、欄には「当たらない」と確かめた文書として残る。history には両方残る
    const off = await c.call("not-applies", { docId: "SJ-133", key: sj133.key });
    expect(off.status).toBe(200);
    const cleared = c.column()!;
    // まとめは、まだ確かめていない文書（SJ-154 など）が残るので関連あり・未照合に戻る（未照合は整合より先。§4-6 のまとめの順）
    expect(cleared.official).toMatchObject({ verdict: "関連あり・未照合", humanChecked: false });
    expect(cleared.official.docs.find((d) => d.id === "SJ-319")?.verdict).toBe("整合");
    expect(cleared.official.docs.some((d) => d.id === "SJ-133")).toBe(false);
    expect(cleared.official.notApplying.map((d) => [d.id, d.verdict])).toEqual([["SJ-133", "対象外"]]);
    expect(cleared.official.checks.find((x) => x.docId === "SJ-133")?.check).toMatchObject({ applies: false });
    expect(events(c.meta()).filter((e) => e.startsWith("OFFICIAL_CHECK"))).toEqual(["OFFICIAL_CHECK{applies}", "OFFICIAL_CHECK{applies}", "OFFICIAL_CHECK{not-applies}"]);
    expect(c.meta().history.at(-1)).toMatchObject({ actor: "veteran", from: "承認済み", to: "承認済み" });

    // 監査ログ：操作（当たる／当たらない）・知識 id と文書 id・結果。本文（文書の条件・要旨）は入らない
    expect(c.audit()).toEqual([
      // 権限で断った操作は、本文を読む前に断るので、対象は知識の id だけ（route() の順番）
      ["not-applies", c.ruleId, "denied", 403, "clerk"],
      ["applies", `${c.ruleId} SJ-133`, "rejected", 409, "clerk"],
      ["applies", `${c.ruleId} SJ-133`, "ok", 200, "clerk"],
      ["applies", `${c.ruleId} SJ-319`, "ok", 200, "clerk"],
      ["not-applies", `${c.ruleId} SJ-133`, "ok", 200, "veteran"],
    ]);
    expect(JSON.stringify(c.as((app) => app.audit.list(500)))).not.toContain("確定病名");
  });

  it("「直す必要がある」→ 停止になり、修正版の候補（未検証）ができる。停止の知識も状態つきで欄と一覧に出るが、確認は 409", async () => {
    const c = await clinic("oc_fail", "なおす");
    await c.switchTo("veteran");
    await c.knowledgePost({ action: "verify", id: c.ruleId, approve: true });
    // 責任者も「当たる」を押せる
    expect((await c.call("applies", { docId: "SJ-133", key: c.keyOf("SJ-133") })).status).toBe(200);
    expect(c.meta().history.at(-1)).toMatchObject({ event: "OFFICIAL_CHECK{applies}", actor: "veteran" });
    await c.meeting();
    const item = c.recheck()!;
    expect(item.reason).toMatchObject({ trigger: "official", official: [{ id: "SJ-133" }] });
    expect(await (await c.answer(item.itemId, 2, "疑いのままのときに限る")).json()).toMatchObject({ status: "applied" });

    // 機械・LLM は状態を決めていない：停止にしたのは責任者の回答（RECHECK_FAIL）
    expect(c.meta().status).toBe("停止");
    expect(c.meta().history.at(-1)).toMatchObject({ event: "RECHECK_FAIL", actor: "veteran", basis: { itemId: item.itemId } });
    const candidate = c.as((app) => listKnowledge(app.store).find((m) => m.relates_to === c.ruleId))!;
    expect(candidate).toMatchObject({ status: "未検証", layer: "ベテラン", polarity: "avoid", matchApprox: true });
    expect(c.as((app) => app.queue().find((k) => k.id === candidate.id))?.body).toContain("疑いのままのときに限る");

    // 停止の知識も隠さない：欄と知識の一覧に状態つきで出る。メンターは使わない。確認はできない（409。状態も記録も変わらない）
    expect(c.column()).toMatchObject({ status: "停止", usedByMentor: false, official: { verdict: "矛盾の恐れ", humanChecked: true, canCheck: false } });
    const listed = c.as((app) => app.knowledgeList().find((k) => k.id === c.ruleId))!;
    expect(listed).toMatchObject({ status: "停止", official: { verdict: "矛盾の恐れ", canCheck: false } });
    const historyBefore = c.meta().history.length;
    for (const kind of ["applies", "not-applies"] as const) {
      const r = await c.call(kind, { docId: "SJ-319", key: c.keyOf("SJ-319") });
      expect(r.status, kind).toBe(409);
      expect((await r.json()).error, kind).toContain("停止");
    }
    expect(c.meta().history).toHaveLength(historyBefore);
    // 修正版の候補も、機械の上では同じ文書に当たる（match は広いまま。L-55）。候補にも確認できる
    expect(c.as((app) => app.knowledgeList().find((k) => k.id === candidate.id))?.official?.checks.map((x) => x.docId)).toContain("SJ-133");
  });

  it("contested・未検証の知識でも確認できる（状態は変わらない）。承認済みでないので ④ は出ない", async () => {
    const c = await clinic("oc_contested", "あらそう");
    // 未検証のまま、事務が「当たる」
    expect((await c.call("applies", { docId: "SJ-319", key: c.keyOf("SJ-319") })).status).toBe(200);
    expect(c.meta().status).toBe("未検証");
    // 再審査を申し出て contested に
    c.as((app) => applyEvent(app.store, c.ruleId, { type: "REEXAM_FILED" }, app.now()));
    expect(c.meta().status).toBe("contested");
    expect((await c.call("applies", { docId: "SJ-133", key: c.keyOf("SJ-133") })).status).toBe(200);
    expect(c.meta()).toMatchObject({ status: "contested", official_checks: { [c.keyOf("SJ-133")]: { applies: true }, [c.keyOf("SJ-319")]: { applies: true } } });
    expect(c.column()).toMatchObject({ status: "contested", official: { verdict: "矛盾の恐れ", humanChecked: true } });
    await c.switchTo("veteran");
    await c.meeting();
    expect(c.meta().status).toBe("contested");
    expect(events(c.meta())).not.toContain("TRIGGER{official}");
  });

  it("確かめる対象でないものは 400：制度層の知識、規則 1〜4 で対象外の文書、「条件つき」の文書、条件の注記のない文書、レジストリにない文書。入力の形が違うものも 400", async () => {
    const c = await clinic("oc_bad", "だめ");
    await c.switchTo("veteran");
    // 条件の注記のない合成の文書（実在の文書ではない）を、このクリニックのレジストリにだけ足す
    const plain = makeDoc({ id: "X-PLAIN", stance: "認める", scope: { kubun: ["D008_19"], payer: "支払基金" } });
    c.docs.push(plain);
    const cases: [string, string, string][] = [
      ["system/r11", "SJ-133", "制度層"],
      [c.ruleId, "SJ-134", "突き合わせの対象ではありません"], // 区分が違う（規則 2）
      [c.ruleId, "SJ-286", "確かめる対象ではありません"], // 条件つき
      [c.ruleId, "X-PLAIN", "確かめる対象ではありません"], // 条件の注記なし
      [c.ruleId, "X-NONE", "突き合わせの対象ではありません"], // レジストリにない
    ];
    for (const [id, docId, message] of cases) {
      for (const kind of ["applies", "not-applies"] as const) {
        const key = c.docs.some((d) => d.id === docId) ? c.keyOf(docId) : `${docId}#00000000`;
        const r = await c.call(kind, { docId, key }, id);
        expect(r.status, `${id} ${docId} ${kind}`).toBe(400);
        expect((await r.json()).error, `${id} ${docId}`).toContain(message);
      }
    }
    expect((await c.call("applies", { docId: "SJ-133", key: c.keyOf("SJ-133") }, "regional/nowhere")).status).toBe(404);
    // 知らない項目・形の違う鍵・パスの区切りを含む id は、スキーマで断る
    const fieldsOf = async (body: unknown, id = c.ruleId) => {
      const r = await c.call("applies", body, id);
      expect(r.status, JSON.stringify(body)).toBe(400);
      return ((await r.json()) as { fields: string[] }).fields;
    };
    expect(await fieldsOf({ docId: "SJ-133", key: c.keyOf("SJ-133"), applies: false })).toEqual(["applies"]);
    expect(await fieldsOf({ docId: "SJ-133", key: c.keyOf("SJ-133"), by: "院長" })).toEqual(["by"]);
    expect(await fieldsOf({ docId: "SJ-133", key: "SJ-133" })).toEqual(["key"]);
    expect(await fieldsOf({ docId: "../x", key: c.keyOf("SJ-133") })).toEqual(["docId"]);
    expect(await fieldsOf({ docId: "SJ-133", key: c.keyOf("SJ-133") }, "regional/../../auth")).toEqual(["id"]);
    expect(c.meta().official_checks).toBeUndefined();
  });

  it("「当たる」はどの役割でも押せる。「当たらない」は責任者だけ（権限表の行で決まる）", async () => {
    const c = await clinic("oc_roles", "やくわり");
    const body = { docId: "SJ-133", key: c.keyOf("SJ-133") };
    for (const role of ["clerk", "manager", "doctor", "veteran"] as const) {
      if (role !== "clerk") await c.switchTo(role);
      expect((await c.call("applies", body)).status, role).toBe(200);
      expect(c.meta().history.at(-1), role).toMatchObject({ event: "OFFICIAL_CHECK{applies}", actor: role });
      expect((await c.call("not-applies", body)).status, role).toBe(role === "veteran" ? 200 : 403);
    }
    expect(c.meta().official_checks).toEqual({ [body.key]: { applies: false, by: instance.clerkIdOf(c.owner), at: c.as((app) => app.now()) } });
  });
});
