// 段 17i：注14 の計算の道具のルート（GET /api/note14、POST /api/note14/worksheets、GET /api/note14/worksheets/:id/draft。design.md §15-13）。実際のルートを呼ぶ。AI は呼ばない
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { autoConsent } from "../helpers/consent";
import { claimId, month } from "../helpers/period";
import { baseFile, receipt, ukeBytes } from "./uke";

let tmp: string;
let instance: typeof import("../../src/server/instance");
let owner: User;
let cookie: string;

// 確認月 M（版に注14 の値がある確認月）と期間の 3 か月。同梱の見本（基準月）と重ならない月にする
const M = month(4);
const [m1, m2, m3] = [month(1), month(2), month(3)];
const NOW = `${M}-13T09:00:00+09:00`;
// 目印の値（記録・応答・監査ログに現れてはいけない）
const MARK = { name: "目印 氏名ＸＹＺ", birth: "19390303", no: "777123" };

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-note14-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("n14_owner", "やまだ", "password123", "demo");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
  instance.runAs(owner, () => instance.getApp().setSetting("now", NOW));
  instance.getAuth().switchRole(owner, "manager");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const app = () => instance.runAs(owner, () => instance.getApp());
const setRole = (role: Role) => instance.getAuth().switchRole(owner, role);
const tool = async (q = "") => (await import("../../app/api/note14/route")).GET(new Request(`http://localhost/api/note14${q}`, { headers: { cookie } }));
const save = async (body: unknown) => (await import("../../app/api/note14/worksheets/route")).POST(new Request("http://localhost/api/note14/worksheets", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
const draft = async (id: number) => (await import("../../app/api/note14/worksheets/[id]/draft/route")).GET(new Request(`http://localhost/api/note14/worksheets/${id}/draft`, { headers: { cookie } }), { params: Promise.resolve({ id: String(id) }) });
const dbRows = (sql: string) => {
  const db = new Database(app().paths.dbFile, { readonly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
};
const body = (over: Record<string, unknown> = {}, months: string[] = [m1, m2, m3], checkMonth = M) => ({
  checkMonth,
  stage1: { months: months.map((month) => ({ month, confirmed: true, kou: null, otsuExtra: null })), gansou: 0, secondPatient: 0, special: "none", institutions: [], ...over },
});
/** 取り込みの一覧にある症例の、R18（エンジン）と取り込んだレセプトの点検（G10 を含む）の結果 */
const judged = () => app().cases().map((c) => [c.claimId, evaluate(c).findings.filter((f) => f.ruleId === "R18").map((f) => `${f.kind}:${f.messageKey ?? ""}`), JSON.stringify(app().ukeCheck(c.claimId, instance.clerkIdOf(owner)))]);

describe("注14 の計算の道具（段 17i）", () => {
  let before: unknown;
  beforeAll(() => {
    // 3 か月分の作り物の UKE（目印の値の患者を含む）
    const file = {
      ...baseFile(),
      receipts: [
        receipt(m1, [{ kubun: "C001_1I", count: 2, dates: [`${m1}-05`, `${m1}-19`] }], MARK),
        receipt(m2, [{ kubun: "C001_1I", count: 1, dates: [`${m2}-07`] }, { kubun: "C001_N7_MITORI", count: 1, dates: [`${m2}-07`] }], MARK),
        receipt(m3, [{ kubun: "C001_1RO", count: 3, dates: [`${m3}-03`, `${m3}-10`, `${m3}-17`] }], MARK),
      ],
    };
    instance.runAs(owner, () => instance.getApp().uploadUke(instance.clerkIdOf(owner), ukeBytes(file)));
    before = judged();
    expect(app().cases().some((c) => c.claimId === claimId("K1"))).toBe(true);
  });

  it("確認月・期間・月ごとの自動の数（取り込んだレセプト n 件から数えた：甲・乙）。期間は M-3〜M-1 と M-12〜M-1（C-325）", async () => {
    const res = await tool(`?month=${M}`);
    expect(res.status).toBe(200);
    const t = await res.json();
    expect(t.period).toEqual({ short: { from: m1, to: m3 }, long: { from: month(-8), to: m3 } });
    expect(t.auto.map((a: { month: string; state: string; kou: number }) => [a.month, a.state, a.kou])).toEqual([[m1, "ok", 2], [m2, "ok", 1], [m3, "ok", 3]]);
    // 初期値は今日以前で最も新しい確認月
    expect((await (await tool()).json()).month).toBe(M);
  });

  it("使うのは事務長と責任者（医療事務・医師は 403）", async () => {
    for (const role of ["clerk", "doctor"] as const) {
      setRole(role);
      expect([role, (await tool()).status, (await save(body())).status]).toEqual([role, 403, 403]);
    }
    setRole("manager");
  });

  it("基準に当たる → 結果を残し、使った期間が記録と応答に出る。下書きは通常・確認月の翌月で、申告の行は増えない（道具は申告を書かない。L-132）", async () => {
    const count = () => dbRows("SELECT COUNT(*) AS n FROM facility_declarations")[0].n;
    const n0 = count();
    const res = await save(body());
    expect(res.status).toBe(200);
    const w = await res.json();
    expect([w.result, w.draft, w.remaining]).toEqual(["meets", true, expect.any(Number)]);
    expect(w.period).toEqual({ short: { from: m1, to: m3 }, long: { from: month(-8), to: m3 } });
    const row = dbRows(`SELECT * FROM note14_worksheets WHERE id = ${w.id}`)[0];
    expect([row.check_month, row.period_3m_from, row.period_3m_to, row.period_12m_from, row.period_12m_to, row.result]).toEqual([M, m1, m3, month(-8), m3, "meets"]);
    const d = await draft(w.id);
    expect(d.status).toBe(200);
    expect(await d.json()).toEqual({ item: "note14", choice: "normal", fromMonth: month(5), checkMonth: M, note: "通知の一般の決まりによる読みです。厚生局に確かめてください" });
    expect(count()).toBe(n0);
  });

  it("決めきれない結果・確認月以外の結果では下書きを作らない（draft が偽、下書きの API は 409）", async () => {
    const u = await (await save(body({ gansou: null, secondPatient: null }))).json();
    expect([u.result, u.draft]).toEqual(["undecided", false]);
    expect((await draft(u.id)).status).toBe(409);
    const off = month(5);
    const o = await (await save(body({ months: [m2, m3, M].map((month) => ({ month, confirmed: false, kou: 0, otsuExtra: 0 })) }, [m2, m3, M], off))).json();
    expect([o.isCheckMonth, o.draft, o.note]).toEqual([false, false, "確認月以外の結果での届出の要否は示されていません"]);
    expect((await draft(o.id)).status).toBe(409);
  });

  it("確かめていない月の自動の数は使わない（手入力の数を使う）。取り込みのない月を確かめたことにはできない（400）。期間の月が違えば 400", async () => {
    const w = await (await save(body({ months: [m1, m2, m3].map((month) => ({ month, confirmed: false, kou: 0, otsuExtra: 0 })) }))).json();
    expect(w.inputs.stage1.months.map((m: { kou: number; source: string }) => [m.kou, m.source])).toEqual([[0, "manual"], [0, "manual"], [0, "manual"]]);
    expect(w.remaining).toBe((await (await tool(`?month=${M}`)).json()).consts.visitThreshold);
    // 取り込みのない月（M）を「全患者分を取り込んだ」にはできない
    expect((await save(body({}, [m2, m3, M], month(5)))).status).toBe(400);
    expect((await save(body({}, [M, month(5), month(6)], month(7)))).status).toBe(400);
    expect((await save(body({}, [m1, m2], M))).status).toBe(400);
    const empty = await save(body({ months: [m1, m2, m3].map((month) => ({ month, confirmed: false, kou: null, otsuExtra: null })) }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toContain(`${m1} の回数（C001 の行）`);
  });

  it("C-326：期間に別表を持たない版の月がある確認月は、その月だけ自動で数えない。確認月の版に注14 の値がない確認月は道具の対象外（計算しない）", async () => {
    const early = await (await tool(`?month=${month(-2)}`)).json();
    expect(early.auto.map((a: { state: string }) => a.state)).toEqual(["no_table", "none", "none"]);
    const out = await (await tool(`?month=${month(-5)}`)).json();
    expect([out.outOfScope, out.text]).toEqual([true, "この確認月は道具の対象外です"]);
    expect((await save(body({}, [month(-8), month(-8), month(-6)], month(-5)))).status).toBe(400);
  });

  it("結果の記録・応答・監査ログに、目印の値（氏名・生年月日・保険者番号）と鍵が現れない。監査ログは確認月と結果の種類だけ", async () => {
    const res = await save(body());
    const text = await res.text();
    const rows = JSON.stringify(dbRows("SELECT * FROM note14_worksheets"));
    const log = JSON.stringify(app().audit.list(500).filter((l) => l.action === "POST /api/note14/worksheets"));
    for (const v of [MARK.name, MARK.name.replace(/\s/g, ""), MARK.birth, MARK.no]) for (const [where, s] of [["応答", text], ["記録", rows], ["監査ログ", log]]) expect(s.includes(v), `${where}: ${v}`).toBe(false);
    expect(app().audit.list(500).filter((l) => l.action === "POST /api/note14/worksheets" && l.result === "ok").map((l) => l.target)).toContain(`${M}・meets`);
  });

  it("見本の症例（K1〜）と取り込んだ請求の R18・G10 の結果が、道具の結果の有無で変わらない（判定は道具の記録を読まない）", () => {
    expect(dbRows("SELECT COUNT(*) AS n FROM note14_worksheets")[0].n).toBeGreaterThan(0);
    expect(judged()).toEqual(before);
  });
});
