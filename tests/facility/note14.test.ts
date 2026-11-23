// 段 17h（design.md §15-2）：施設の申告 note14 の三値・効く行・確かめ直す日の既定（版の定数と EM R8-201）、道具の結果との比べ（L-160。round-57 C-320〜round-60 C-350）。
// 段 17i：道具の結果の表（note14_worksheets。マイグレーション 16）を通した通しのテスト（下の「表を通して」）。実際のルートを呼ぶ。AI は呼ばない
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { deriveLines, manualLinesOf } from "../../src/engine/derive";
import type { ClaimContext } from "../../src/engine/types";
import type { User } from "../../src/server/auth";
import { autoConsent } from "../helpers/consent";
import { day, month } from "../helpers/period";
import { baseFile, receipt, ukeBytes } from "../note14/uke";
import { loadCase } from "../engine/helpers";
import { REVISIONS, resolveRevision } from "../../src/engine/revisions";
import { effectiveRow, facilityFromDeclaration, note14Tri, NOTE14_KEY, type DeclarationRow } from "../../src/facility/declaration";
import { nextCheckMonthEnd, note14Compare, type Note14Result } from "../../src/facility/note14";
import { recheckDefaultOf } from "../../src/server/app/facility";
import { declarationBody } from "../../src/server/schemas/facility";

const TODAY = "2026-11-13";
const YM = "2026-10";
let id = 0;
const row = (o: Partial<DeclarationRow>): DeclarationRow => ({
  id: ++id,
  itemKey: NOTE14_KEY,
  fromMonth: YM,
  notified: "na",
  notifiedOn: null,
  startOn: null,
  requirement: "met",
  choice: "normal",
  checkedBy: "やまだ",
  checkedRole: "manager",
  checkedOn: "2026-11-01",
  recheckOn: "2027-02-28",
  source: "input",
  createdAt: "",
  ...o,
});

describe("note14 の三値と効く行", () => {
  it("通常の点数・減算の点数・分からない。確かめ直す日を過ぎた行・その月に効く行がない申告は分からない。算定開始年月日は見ない", () => {
    const n = (rows: DeclarationRow[], ym = YM) => facilityFromDeclaration(rows, TODAY, ym).note14;
    expect(n([row({ choice: "normal" })])).toBe("通常");
    expect(n([row({ choice: "reduced", startOn: "2026-12-01" })])).toBe("減算");
    expect(n([row({ choice: "unknown" })])).toBeNull();
    expect(n([row({ recheckOn: "2026-11-01" })])).toBeNull();
    expect(n([row({ fromMonth: "2026-11" })])).toBeNull();
    expect(n([])).toBeNull();
    // 効く行は 15-2 の規則（有効月の順。入れた順は効かない）
    const rows = [row({ fromMonth: "2026-12", choice: "reduced" }), row({ fromMonth: "2026-09", choice: "normal" })];
    expect([n(rows, "2026-10"), n(rows, "2026-12")]).toEqual(["通常", "減算"]);
    expect(note14Tri(rows, TODAY, "2026-08")).toEqual({ v: "unknown", reason: "no_month_row" });
    expect(effectiveRow(rows, NOTE14_KEY, "2026-11")?.row.choice).toBe("normal");
  });

  it("API の形：三値と from_month が要る（ないものは 400 の形）。override は理由の種類と確認月だけ（自由記述の欄はない）", () => {
    const ok = { item: "note14", fromMonth: YM, choice: "normal", notifiedOn: null, startOn: null, checkedOn: TODAY, recheckOn: "2027-02-28" };
    expect(declarationBody.safeParse(ok).success).toBe(true);
    expect(declarationBody.safeParse({ ...ok, fromMonth: undefined }).success).toBe(false);
    expect(declarationBody.safeParse({ ...ok, choice: "yes" }).success).toBe(false);
    expect(declarationBody.safeParse({ ...ok, override: { reason: "kouseikyoku", month: "2026-11" } }).success).toBe(true);
    expect(declarationBody.safeParse({ ...ok, override: { reason: "kouseikyoku", month: "2026-11", text: "電話で" } }).success).toBe(false);
    expect(declarationBody.safeParse({ ...ok, override: { reason: "free", month: "2026-11" } }).success).toBe(false);
  });
});

describe("確かめ直す日の既定：確かめた日の次の確認月の末日（確認月は版の定数。EM R8-201）", () => {
  it("版の定数の確認月が EM R8-201 の「毎年 2・5・8・11 月」と合う", () => {
    const em = readFileSync(path.join(__dirname, "../../design/iji-context/sources/evidence-master-iji-context.md"), "utf8");
    const r201 = em.split("\n").find((l) => l.startsWith("| R8-201 |"))!;
    const m = /毎年 \*\*([\d・]+) 月\*\*/.exec(r201)!;
    const months = m[1].split("・").map(Number);
    expect(months).toEqual([2, 5, 8, 11]);
    for (const rev of REVISIONS) expect(rev.consts.note14?.checkMonths, rev.id).toEqual(months);
  });
  it("次の確認月の末日（確認月の中で確かめたら、その次の確認月）", () => {
    const months = resolveRevision(YM).consts.note14!.checkMonths;
    expect(nextCheckMonthEnd("2026-10-05", months)).toBe("2026-11-30");
    expect(nextCheckMonthEnd("2026-11-13", months)).toBe("2027-02-28");
    expect(nextCheckMonthEnd("2026-12-01", months)).toBe("2027-02-28");
    expect(nextCheckMonthEnd("2027-02-28", months)).toBe("2027-05-31");
    expect(recheckDefaultOf({ note16: 3, default: 12 }, NOTE14_KEY, "2026-10-13")).toBe("2026-11-30");
    // ほかの項目は今までどおり月数
    expect(recheckDefaultOf({ note16: 3, default: 12 }, "note16", "2026-10-13")).toBe("2027-01-13");
  });
});

describe("道具の結果との比べ（純関数。round-58 C-331・round-59 C-342・round-60 C-350。L-160）", () => {
  const r = (checkMonth: string, outcome: Note14Result["outcome"], seq: number): Note14Result => ({ checkMonth, outcome, seq });
  it("結果がまだない：none（どの入口も止めない）", () => {
    expect(note14Compare([], "normal", TODAY).state).toBe("none");
  });
  it("not_meets があり meets で上書きされず、申告が通常 → block。減算なら止めない。undecided を追記しても戻らない。meets を追記すると外れる", () => {
    expect(note14Compare([r("2026-11", "not_meets", 1)], "normal", TODAY).state).toBe("block");
    expect(note14Compare([r("2026-11", "not_meets", 1)], "reduced", TODAY).state).toBe("same");
    expect(note14Compare([r("2026-11", "not_meets", 1), r("2026-11", "undecided", 2)], "normal", TODAY).state).toBe("block");
    expect(note14Compare([r("2026-11", "not_meets", 1), r("2026-11", "meets", 2)], "normal", TODAY).state).toBe("same");
    // meets で申告が減算（点数の低い側）は止めず、違いを添える
    expect(note14Compare([r("2026-11", "meets", 1)], "reduced", TODAY).state).toBe("differs");
  });
  it("比べる結果は、今日以前で結果のある最も新しい確認月（次の確認月に入って道具をまだ回していないあいだは前の確認月の結果が効く）", () => {
    const results = [r("2026-08", "meets", 1), r("2026-11", "not_meets", 1)];
    const s = note14Compare(results, "normal", "2027-02-10");
    expect([s.month, s.state]).toEqual(["2026-11", "block"]);
    // 先の確認月の結果は比べない
    expect(note14Compare([...results, r("2027-02", "meets", 1)], "normal", "2027-01-31").month).toBe("2026-11");
  });
});

describe("表を通して（段 17i。note14_worksheets を読む。round-57 C-320・round-58 C-331・round-59 C-342・round-60 C-350。L-155・L-160）", () => {
  let tmp: string;
  let instance: typeof import("../../src/server/instance");
  let owner: User;
  let cookie: string;
  // 確認月 M と、その次の確認月（3 か月後）
  const M = month(1);
  const NEXT = month(4);
  const setNow = (ym: string) => instance.runAs(owner, () => instance.getApp().setSetting("now", `${ym}-13T09:00:00+09:00`));
  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "iji-note14-table-"));
    process.env.RESEMEN_DATA = tmp;
    process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
    delete process.env.RESEMEN_OPEN_SIGNUP;
    instance = await import("../../src/server/instance");
    autoConsent(instance.getAuth());
    owner = instance.getAuth().register("n14_table", "やまだ", "password123", "demo");
    cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
    instance.getAuth().switchRole(owner, "manager");
    setNow(M);
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.RESEMEN_DATA;
    delete process.env.RESEMEN_WORKSPACES;
  });
  const app = () => instance.runAs(owner, () => instance.getApp());
  const URL_ = "http://localhost/api/facility/declaration";
  const json = (b: unknown) => ({ method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) });
  const save = async (b: unknown) => (await import("../../app/api/facility/declaration/route")).POST(new Request(URL_, json(b)));
  const list = async () => (await (await (await import("../../app/api/facility/declaration/route")).GET(new Request(URL_, { headers: { cookie } }))).json()) as { items: { key: string; row: { id: number } | null }[]; note14: { state: string; month: string | null; managerLine?: string; undecidedLine?: string } };
  const confirm = async (ids: number[]) => (await import("../../app/api/facility/declaration/confirm/route")).POST(new Request(`${URL_}/confirm`, json({ ids })));
  /** 道具の結果を 1 行足す（道具の画面を通さずに、確認月と結果の種類だけ。比べの側を確かめるため） */
  const addResult = (checkMonth: string, result: "meets" | "not_meets" | "undecided") => {
    const db = new Database(app().paths.dbFile);
    try {
      db.prepare("INSERT INTO note14_worksheets (check_month, period_3m_from, period_3m_to, period_12m_from, period_12m_to, inputs, outcomes, result, splits, checked_by, checked_on, created_at) VALUES (?, '', '', '', '', '{}', '{}', ?, '[]', 'やまだ', ?, ?)").run(checkMonth, result, `${checkMonth}-13`, new Date().toISOString());
    } finally {
      db.close();
    }
  };
  const worksheetCount = () => {
    const db = new Database(app().paths.dbFile, { readonly: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM note14_worksheets").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };
  const n14 = (o: Record<string, unknown> = {}) => ({ item: "note14", fromMonth: YM, choice: "normal", notifiedOn: null, startOn: null, checkedOn: day(1), recheckOn: day(10), ...o });
  const rowOf = async (key: string) => (await list()).items.find((i) => i.key === key)!.row!;

  it("C-320：道具の結果が undecided の確認月でも、「決めきれないまま」の行から note14 を「変わりなし」で残すと、同じ点検で情報不足が消え D03 の保留も外れる（道具の記録は変わらない）", async () => {
    // 10〜19 人の区分の管理料の行がある請求と、その患者の人数の区分（建物は「ある」）
    expect((await save({ item: "building", fromMonth: YM, choice: "some", checkedOn: day(1), recheckOn: `${month(12)}-01` })).status).toBe(200);
    const file = { ...baseFile(), receipts: [receipt(YM, [{ kubun: "C001_1RO", count: 2, dates: [day(5), day(19)] }, { kubun: "C002_2RO3", count: 1, dates: [day(19)] }], { name: "架空 菊子", birth: "19450505" })] };
    const id = app().uploadUke(instance.clerkIdOf(owner), ukeBytes(file)).flatMap((u) => u.receipts.map((x) => x.claimId)).find((c) => c.startsWith("U"))!;
    app().savePatientFact(id, instance.clerkIdOf(owner), { key: "buildingBand", value: { band: "10-19", fromMonth: YM }, source: "カルテ", validUntil: null });
    // 確かめ直す日（10 日）を過ぎた「通常」
    expect((await save(n14())).status).toBe(200);
    addResult(M, "undecided");
    const d = await list();
    expect(d.note14.undecidedLine).toBe(`注14：決めきれないまま（${M}）`);
    expect(d.note14.state).not.toBe("block");
    const c = () => app().caseOf(id);
    const shortage = () => evaluate(c()).findings.filter((f) => f.missing?.field === "facility.note14").map((f) => f.ruleId);
    const held = (x: ClaimContext) => deriveLines({ yearMonth: x.yearMonth, facility: x.facility, facts: x.facts, events: x.events, history: x.history, manual: manualLinesOf(x.lines, resolveRevision(x.yearMonth)), choices: {} }).pending.filter((p) => "need" in p && p.need === "facility.note14");
    expect(shortage()).toEqual(["R18"]);
    // D03 は、見本の症例 K2 の事実（人数の区分だけをこの患者の値にする）と、この施設の申告から作った施設の設定で導出する
    const k2 = loadCase("K2");
    const withFacility = () => ({ ...k2, facility: c().facility, facts: { ...k2.facts, buildingBand: c().facts.buildingBand } });
    expect(held(withFacility())).toHaveLength(1);
    const n = worksheetCount();
    const res = await confirm([(await rowOf("note14")).id]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([{ id: expect.any(Number), ok: true }]);
    expect(shortage()).toEqual([]);
    expect(held(withFacility())).toEqual([]);
    expect(worksheetCount()).toBe(n);
  });

  it("C-331・C-342：not_meets で申告が通常のとき、知らせの比べが block（「変わりなし」を出さず「道具の結果と今の申告が違います」）。reconfirm はその行を断り、まとめて送ると note14 の行だけ断られ、ほかの行は追記される", async () => {
    addResult(M, "not_meets");
    expect((await save(n14({ recheckOn: `${NEXT}-28`, override: { reason: "kouseikyoku", month: M } }))).status).toBe(200);
    const d = await list();
    expect([d.note14.state, d.note14.month]).toEqual(["block", M]);
    const note14 = await rowOf("note14");
    const building = await rowOf("building");
    const res = await confirm([note14.id, building.id]);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { results: { id: number; ok: boolean; reason?: string }[]; items: { key: string; row: { id: number } | null }[] };
    expect(out.results).toEqual([{ id: note14.id, ok: false, reason: "道具の結果と今の申告が違います" }, { id: building.id, ok: true }]);
    expect(out.items.find((i) => i.key === "note14")!.row!.id).toBe(note14.id);
    expect(out.items.find((i) => i.key === "building")!.row!.id).not.toBe(building.id);
    // あとから undecided を足しても止めは外れない（C-342 の (c)）
    addResult(M, "undecided");
    expect((await list()).note14.state).toBe("block");
  });

  it("C-350（L-160）：次の確認月に入って道具を回していない日に reconfirm を送ると、前の確認月の not_meets で断られる。通常を残すと警告と理由が要り（理由なしは 400）、残すと監査ログに印と理由の種類、事務長の画面に 1 行（meets の追記か減算の選び直しで消える）", async () => {
    setNow(NEXT);
    const res = await confirm([(await rowOf("note14")).id]);
    expect(((await res.json()) as { results: { ok: boolean }[] }).results).toEqual([expect.objectContaining({ ok: false })]);
    expect((await save(n14({ fromMonth: NEXT, recheckOn: `${month(7)}-28` }))).status).toBe(400);
    expect((await save(n14({ fromMonth: NEXT, recheckOn: `${month(7)}-28`, override: { reason: "input_wrong", month: M } }))).status).toBe(200);
    const log = app().audit.list(500).filter((l) => l.action === "POST /api/facility/declaration" && l.result === "ok").map((l) => l.target);
    expect(log).toContain(`note14（道具の結果と違うまま残した：${M}・道具の入力が違っていた）`);
    // 理由を選んで残しても、事務長の画面の 1 行は消えない
    expect((await list()).note14.managerLine).toBe(`注14：道具の結果と違う申告で残しています（${M}）`);
    // 減算に選び直すと消える
    expect((await save(n14({ fromMonth: NEXT, choice: "reduced", recheckOn: `${month(7)}-28` }))).status).toBe(200);
    expect((await list()).note14.managerLine).toBeUndefined();
    // 通常に戻すと出る。meets を追記すると消える
    expect((await save(n14({ fromMonth: NEXT, recheckOn: `${month(7)}-28`, override: { reason: "other", month: M } }))).status).toBe(200);
    expect((await list()).note14.managerLine).toBeDefined();
    addResult(M, "meets");
    expect((await list()).note14.managerLine).toBeUndefined();
    expect((await list()).note14.state).toBe("same");
  });
});
