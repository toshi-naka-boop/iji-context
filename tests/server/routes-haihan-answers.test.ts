// 段 15a：背反の特例条件の例外の問いの答え（design.md §13-3）。今ある請求ごとの事実のルート（POST /api/claims/[claimId]/facts）に、haihan:* と共有の事実を足した。
// 答えを書く関数は 1 つ（saveClaimFact）。「その他」「判定不能」→ その日の共有の事実（sameDayOushinAfterVisit）を取り消し（R10 も不明に戻る）、haihan:* に答えを残す。
// 「はい」「いいえ」→ haihan:* を取り消して共有の事実を書く。取り消しは "__cleared__" の行を足す（行は消さない）。権限・監査ログは今の事実の入力と同じ。
// マスター（RESEMEN_MASTER_DIR）があれば、取り込んだレセプトの点検の G05 の問いが、答えで変わることも見る
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import type { Finding } from "../../src/engine/types";
import { haihanKey } from "../../src/generic/haihan";
import type { GenericView } from "../../src/generic/view";
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
/** 5 日と 15 日に、訪問診療料と往診料の両方がある請求。5 日には、再診料と、訪問診療料(Ⅰ)1ロ（同一建物居住者）もある（再診料×訪問診療料の 2 つの組） */
const ID = "U1-1";
const KEY = haihanKey("HX-01", OUSHIN_CODE, VISIT_CODE);
const [SAISHIN, HOUMON_RO] = [rev.codes.A001.primary, rev.codes.C001_1RO.primary];
const YES = "はい、訪問診療のあとに、急変などで往診した";
const masters = process.env.RESEMEN_MASTER_DIR ? path.join(process.env.RESEMEN_MASTER_DIR, "masters.db") : "";
const hasMasters = masters !== "" && existsSync(masters);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-haihan-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("haihan_owner", "やまだ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
  const r = base.receipts[0];
  const file: UkeFile = {
    ...base,
    receipts: [{ ...r, claimId: "A1", patient: { ...r.patient, name: "架空 松子", birth: "19480808", insurer: { number: "06139992", symbol: "77", no: "602" } }, lines: [{ kubun: VISIT, count: 2, dates: [day(5), day(15)] }, { kubun: OUSHIN, count: 2, dates: [day(5), day(15)] }, { kubun: "A001", count: 1, dates: [day(5)] }, { kubun: "C001_1RO", count: 1, dates: [day(5)] }], comments: [] }],
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
const routes = () => import("../../app/api/claims/[claimId]/facts/route");
const setRole = (role: Role) => instance.getAuth().switchRole(owner, role);
const save = async (key: string, value: unknown, date: string | null) => (await routes()).POST(post(`/api/claims/${ID}/facts`, { fact: { key, date, value, source: "カルテ" } }), params(ID));
const list = async () => ((await (await (await routes()).GET(get(`/api/claims/${ID}/facts`), params(ID))).json()) as { facts: { key: string; date: string | null; value: unknown; target: string }[] }).facts.map((f) => [f.key, f.date, f.value, f.target]);
const r10 = () => (instance.runAs(owner, () => instance.getApp().ukeCheck(ID)) as { missing: Finding[] }).missing.filter((f) => f.ruleId === "R10").map((f) => `${f.missing!.field}@${f.missing!.date ?? ""}`);
const rows = () => {
  const db = new Database(instance.tenantPaths(owner.tenantId).dbFile, { readonly: true });
  try {
    return db.prepare("SELECT key, date, value FROM claim_facts WHERE claim_id = ? ORDER BY id").all(ID) as { key: string; date: string; value: string }[];
  } finally {
    db.close();
  }
};
const g05 = () => (instance.runAs(owner, () => instance.getApp().ukeCheck(ID)) as { generic?: GenericView }).generic?.findings.filter((f) => f.check === "G05") ?? [];

describe("背反の特例条件の例外の問いの答え（haihan:*）", () => {
  it("形の違う答え（選択肢にない・日付がない・問いのない例外・形の違う key）は 400。医師の役割は 403。何も残らない", async () => {
    setRole("clerk");
    for (const [key, value, date] of [
      [KEY, "たぶん", day(5)],
      [KEY, YES, null],
      [KEY, YES, `${YM}-32`],
      [haihanKey("HX-13", OUSHIN_CODE, VISIT_CODE), "その他", day(5)],
      [haihanKey("HX-99", OUSHIN_CODE, VISIT_CODE), "その他", day(5)],
      [`haihan:HX-01:${VISIT_CODE}:${OUSHIN_CODE}`, "その他", day(5)],
      [haihanKey("HX-22", OUSHIN_CODE, VISIT_CODE), "その他", day(5)],
    ] as const)
      expect([key, value, date, (await save(key, value, date)).status]).toEqual([key, value, date, 400]);
    // 取り消しの印（"__cleared__"）は、どの事実の値としても受け付けない（round-36 C-141）
    expect((await save(KEY, "__cleared__", day(5))).status).toBe(400);
    setRole("doctor");
    for (const v of ["__cleared__", " __cleared__ "]) expect([v, (await save("mainDisease", v, null)).status]).toEqual([v, 400]);
    expect((await save(KEY, YES, day(5))).status).toBe(403);
    setRole("clerk");
    expect(await list()).toEqual([]);
  });

  it("共有の事実を使う問い（HX-01）：はい → sameDayOushinAfterVisit を書く。その他 → その日の共有の事実を取り消し（R10 も不明に戻る）、haihan:* に答えを残す。いいえ → haihan:* を取り消して共有の事実を書く", async () => {
    setRole("clerk");
    expect(r10()).toEqual([`sameDayOushinAfterVisit@${day(5)}`, `sameDayOushinAfterVisit@${day(15)}`]);
    expect((await save(KEY, YES, day(5))).status).toBe(200);
    expect(await list()).toEqual([["sameDayOushinAfterVisit", day(5), true, "clerk"]]);
    expect(r10()).not.toContain(`sameDayOushinAfterVisit@${day(5)}`);
    // その他：R10 も 5 日を聞き直す。15 日の答えには効かない
    expect((await save(KEY, "その他", day(5))).status).toBe(200);
    expect(await list()).toEqual([[KEY, day(5), "その他", "clerk"]]);
    expect(r10()).toEqual([`sameDayOushinAfterVisit@${day(5)}`, `sameDayOushinAfterVisit@${day(15)}`]);
    // いいえ（往診が先）：haihan:* を取り消し、共有の事実を偽で書く
    expect((await save(KEY, "いいえ、往診のほうが先だった", day(5))).status).toBe(200);
    expect(await list()).toEqual([["sameDayOushinAfterVisit", day(5), false, "clerk"]]);
    expect(r10()).toContain(`sameDaySeparate@${day(5)}`);
    // 行は消さず、取り消しの行を足している（経過が残る）
    expect(rows().map((r) => [r.key, r.date, JSON.parse(r.value)])).toEqual([
      ["sameDayOushinAfterVisit", day(5), true],
      ["sameDayOushinAfterVisit", day(5), "__cleared__"],
      [KEY, day(5), "その他"],
      [KEY, day(5), "__cleared__"],
      ["sameDayOushinAfterVisit", day(5), false],
    ]);
  });

  it("共有の事実を直接書いたとき（R10 の入力）も、その日の「もう問わない記録」を取り消す", async () => {
    setRole("clerk");
    expect((await save(KEY, "判定不能", day(15))).status).toBe(200);
    expect((await list()).map((f) => f[0])).toContain(KEY);
    expect((await save("sameDayOushinAfterVisit", true, day(15))).status).toBe(200);
    expect((await list()).filter((f) => f[1] === day(15))).toEqual([["sameDayOushinAfterVisit", day(15), true, "clerk"]]);
  });

  it("R10 の入力（sameDayOushinAfterVisit）も、HX-01 と同じ選択肢で答えられ、同じ書く関数を通る：その他 → 共有の事実を取り消し、その日の組の haihan:* に記録（利用者の判断 2026-11-22）", async () => {
    setRole("clerk");
    expect((await save("sameDayOushinAfterVisit", "たぶん", day(15))).status).toBe(400);
    expect((await save("sameDayOushinAfterVisit", "その他", day(15))).status).toBe(200);
    expect((await list()).filter((f) => f[1] === day(15))).toEqual([[KEY, day(15), "その他", "clerk"]]);
    expect(r10()).toContain(`sameDayOushinAfterVisit@${day(15)}`);
    expect((await save("sameDayOushinAfterVisit", YES, day(15))).status).toBe(200);
    expect((await list()).filter((f) => f[1] === day(15))).toEqual([["sameDayOushinAfterVisit", day(15), true, "clerk"]]);
  });

  it("答えは組ごと：同じ日の 2 つの組（haihan:<HX>:<コード①>:<コード②>）に別の答えを残せ、互いに効かない", async () => {
    setRole("clerk");
    const [a, b] = [haihanKey("HX-11", SAISHIN, VISIT_CODE), haihanKey("HX-11", SAISHIN, HOUMON_RO)];
    const NO = "いいえ、訪問診療と同じ 1 回の診療について算定した";
    expect((await save(a, NO, day(5))).status).toBe(200);
    expect((await save(b, "その他", day(5))).status).toBe(200);
    const mine = (await list()).filter((f) => f[0] === a || f[0] === b);
    expect(mine).toEqual([[a, day(5), NO, "clerk"], [b, day(5), "その他", "clerk"]]);
  });

  it("答えの key のコードが、その請求の行にない・その例外の組（HP の a・b）に当たらないなら 400（round-36 C-143）", async () => {
    setRole("clerk");
    // 実在しないコード／組に当たるが請求にない訪問診療料(Ⅰ)2（114042110）／請求にあるが HX-01 の組（往診料×訪問診療料）に当たらない再診料×往診料
    for (const key of [haihanKey("HX-01", "111111111", "222222222"), haihanKey("HX-01", OUSHIN_CODE, "114042110"), haihanKey("HX-01", SAISHIN, OUSHIN_CODE)])
      expect([key, (await save(key, YES, day(5))).status]).toEqual([key, 400]);
  });

  it("監査ログの対象は請求 id とキーだけ（値・氏名は入らない）。答えを書く関数がほかに書いた・取り消した key は、key ごとに 1 行ずつ残す（切れない。round-38 X-112）", async () => {
    setRole("clerk");
    // 同じ日の HX-01 の 2 つの組に「その他」を残したあと、R10 の入力で共有の事実を書く → 2 つの答えを取り消す
    const RO = haihanKey("HX-01", OUSHIN_CODE, HOUMON_RO);
    for (const k of [KEY, RO]) expect((await save(k, "その他", day(5))).status).toBe(200);
    const before = instance.runAs(owner, () => instance.getApp().audit.list(500)).length;
    expect((await save("sameDayOushinAfterVisit", true, day(5))).status).toBe(200);
    const added = instance.runAs(owner, () => instance.getApp().audit.list(500)).slice(0, instance.runAs(owner, () => instance.getApp().audit.list(500)).length - before);
    expect(added.map((r) => r.target).sort()).toEqual([`${ID} sameDayOushinAfterVisit`, `${ID} ${KEY}`, `${ID} ${RO}`].sort());
    const audit = instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((r) => r.action === "POST /api/claims/[claimId]/facts" && r.result === "ok");
    // 共有の事実を使う問いの答え → その事実の key の行も残る
    expect(audit.map((r) => r.target)).toContain(`${ID} ${KEY}`);
    expect(audit.map((r) => r.target)).toContain(`${ID} ${haihanKey("HX-11", SAISHIN, VISIT_CODE)}`);
    for (const r of audit) expect((r.target ?? "").length).toBeLessThanOrEqual(80);
    // 5 日を前の状態（往診のあとではない）に戻す（次のテストが使う）
    expect((await save("sameDayOushinAfterVisit", false, day(5))).status).toBe(200);
    expect(JSON.stringify(audit)).not.toMatch(/架空|06139992|やまだ|往診のほうが先|その他/);
  });

  it.skipIf(!hasMasters)("（マスターがあるとき）取り込んだレセプトの点検の G05：答えのない日は問いがつき、「その他」と答えた日は、もう問わない", async () => {
    setRole("clerk");
    // 5 日は「いいえ」（往診が先）で、別々の診療かを問う（R10 と同じ問い）。15 日は「はい」と答えてある
    const asks = g05().filter((f) => f.codes.some((c) => c.code === OUSHIN_CODE)).flatMap((f) => f.asks ?? []);
    // 往診料×訪問診療料の 2 つの組（1イ・1ロ）が、同じ日の同じ問いを持つ
    expect(asks.map((a) => [a.kind, a.key, a.dates])).toEqual([["fact", "sameDaySeparate", [day(5)]], ["fact", "sameDaySeparate", [day(5)]]]);
    // 「その他」は組ごと：1イの組に答えると、共有の事実を取り消すので、1ロの組は HX-01 の問いになる。1ロの組にも答えると、もう問わない
    expect((await save(KEY, "その他", day(5))).status).toBe(200);
    expect(g05().filter((f) => f.codes.some((c) => c.code === OUSHIN_CODE)).flatMap((f) => f.asks ?? []).map((a) => [a.kind, a.key])).toEqual([["choice", haihanKey("HX-01", OUSHIN_CODE, HOUMON_RO)]]);
    expect((await save(haihanKey("HX-01", OUSHIN_CODE, HOUMON_RO), "その他", day(5))).status).toBe(200);
    const oushin = g05().filter((f) => f.codes.some((c) => c.code === OUSHIN_CODE));
    expect(oushin.flatMap((f) => f.asks ?? [])).toEqual([]);
    expect(oushin.map((f) => f.text).join("")).not.toContain("下の問いに答えてください");
  });
});
