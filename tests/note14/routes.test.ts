// 段 17i：注14 の計算の道具のルート（GET /api/note14、POST /api/note14/worksheets、GET /api/note14/worksheets/:id/draft。design.md §15-13）。実際のルートを呼ぶ。AI は呼ばない
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { DRAFT_TEXT } from "../../src/note14/drafts";
import { fieldKeys } from "../../src/note14/readings";
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
/** 見本の症例（K1〜。途中で足す請求と月が重ならない）の、R18（エンジン）と取り込んだレセプトの点検（G10 を含む）の結果 */
const judged = () => app().cases().filter((c) => c.claimId.startsWith("K")).map((c) => [c.claimId, evaluate(c).findings.filter((f) => f.ruleId === "R18").map((f) => `${f.kind}:${f.messageKey ?? ""}`), JSON.stringify(app().ukeCheck(c.claimId, instance.clerkIdOf(owner)))]);

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

  it("C-362：特別の関係にある保険医療機関が空（null）なら残さず 400 で名指しする", async () => {
    const res = await save(body({ special: null }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("特別の関係にある保険医療機関（ない／ある／分からない）");
  });

  it("段 17j：門以上なら 2 段目の欄が要り（空は 400 で名指し）、4 つを満たせば基準に当たる（下書きは通常）、1 つでも満たさなければ基準に当たらない（下書きは減算）。知らない欄の鍵は 400", async () => {
    const T = (await (await tool(`?month=${M}`)).json()).consts.visitThreshold as number;
    const manual = [m1, m2, m3].map((month, i) => ({ month, confirmed: false, kou: i === 0 ? T : 0, otsuExtra: 0 }));
    const missing = await save(body({ months: manual }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("① C002 を算定した患者の数（実人数）");
    const values = (referral: number) => Object.fromEntries(fieldKeys().map((f) => [f.key, f.field.id === "referral" ? referral : f.field.id === "mitoriHome" ? 20 : f.field.id === "excluded" ? 0 : f.field.id === "jushoji" || f.field.id.startsWith("mitori") ? 0 : 50]));
    const meets = await (await save({ ...body({ months: manual }), stage2: { values: values(5) } })).json();
    expect(meets.result).toBe("meets");
    expect((await (await draft(meets.id)).json()).choice).toBe("normal");
    const not = await (await save({ ...body({ months: manual }), stage2: { values: values(4) } })).json();
    expect(not.result).toBe("not_meets");
    expect((await (await draft(not.id)).json()).choice).toBe("reduced");
    expect(not.inputs.stage2.values["c002:U-33a=A"]).toBe(50);
    expect((await save({ ...body({ months: manual }), stage2: { values: { ...values(5), "c002:same": 50 } } })).status).toBe(400);
  });

  it("段 17k：2 段目の下書き（①②③⑤）が取り込んだ請求と患者の事実から入り、未入力 n 人が出る。下書きのままの欄は出どころが自動、直した欄は手入力で記録に残る。同じ値を手で入れたときと結果が同じ", async () => {
    const P1 = { name: "架空 下書一", birth: "19380808", no: "880001" };
    const P2 = { name: "架空 下書二", birth: "19370707", no: "880002" };
    const file = {
      ...baseFile(),
      receipts: [
        ...[m1, m2, m3].map((m) => receipt(m, [{ kubun: "C001_1I", count: 1, dates: [`${m}-06`] }, { kubun: "C002_2RO1", count: 1, dates: [`${m}-06`] }], P1)),
        ...[m1, m2].map((m) => receipt(m, [{ kubun: "C001_1I", count: 1, dates: [`${m}-08`] }, { kubun: "C002-2_2RO1", count: 1, dates: [`${m}-08`] }], P2)),
        receipt(m3, [{ kubun: "C001_1I", count: 1, dates: [`${m3}-08`] }, { kubun: "C002-2_2RO1", count: 1, dates: [`${m3}-08`] }, { kubun: "C001_N7_MITORI", count: 1, dates: [`${m3}-08`] }], P2),
      ],
    };
    const ids = instance.runAs(owner, () => instance.getApp().uploadUke(instance.clerkIdOf(owner), ukeBytes(file))).flatMap((u) => u.receipts.filter((x) => x.patient === P1.name).map((x) => x.claimId));
    app().savePatientFact(ids[0], instance.clerkIdOf(owner), { key: "careLevel", value: 3, source: "介護保険証", validUntil: `${month(12)}-01` });
    const t = await (await tool(`?month=${M}`)).json();
    expect(t.draft.ok).toBe(true);
    const pick = (id: string) => Object.fromEntries(Object.entries(t.draft.values as Record<string, number>).filter(([k]) => k.split(":")[0] === id));
    expect({ ...pick("c002"), ...pick("c0022") }).toEqual({ "c002:U-33a=A": 1, "c002:U-33a=B": 3, "c0022:U-33a=A": 1, "c0022:U-33a=B": 3 });
    expect(pick("excluded")).toEqual({ "excluded:U-33a=A:U-33b=A": 1, "excluded:U-33a=A:U-33b=B": 1, "excluded:U-33a=B:U-33b=A": 3, "excluded:U-33a=B:U-33b=B": 1 });
    // C-372：⑤ の各月の末日（U-33c の乙）の欄は下書きしない（空のまま手入力を求め、その旨を出す）
    expect(pick("care")).toEqual({ "care:U-33a=A:U-33c=A": 1, "care:U-33a=B:U-33c=A": 3 });
    expect(t.draft.notes).toContain(DRAFT_TEXT.careEnd);
    expect([t.draft.unknownCare, t.draft.text]).toEqual([1, "要介護度・別表第八の二の状態が未入力 1 人（下書きの数に入れていません）。認知症の自立度・障害支援区分で当たる患者は、事実にないので足してください"]);
    const T = t.consts.visitThreshold as number;
    const manual = [m1, m2, m3].map((month, i) => ({ month, confirmed: false, kou: i === 0 ? T : 0, otsuExtra: 0 }));
    const values = { ...Object.fromEntries(fieldKeys().map((f) => [f.key, f.field.id === "referral" ? 5 : f.field.id === "mitoriHome" ? 20 : 0])), ...t.draft.values };
    const auto = Object.fromEntries(Object.keys(t.draft.values).map((k) => [k, "auto"]));
    // C-373：1 段目で「全患者分を取り込んだ」を確かめていない月があれば、下書きのままの欄も自動の印にしない
    const unconfirmed = await (await save({ ...body({ months: manual }), stage2: { values, sources: auto } })).json();
    expect(Object.values(unconfirmed.inputs.stage2.sources as Record<string, string>).every((x) => x === "manual")).toBe(true);
    // 3 か月とも確かめた月（自動の数）で、読み乙だけの手入力の欄で門以上にして 2 段目を開く
    const confirmed = body({ gansou: T });
    // C-363：③ の下書きは拾う範囲が一部の行だけなので、本人が足す患者を確かめるまで結果を出さない（自動で確定扱いにしない）
    expect(t.draft.notes).toContain(DRAFT_TEXT.excludedPartial);
    const unchecked = await save({ ...confirmed, stage2: { values, sources: auto } });
    expect(unchecked.status).toBe(400);
    expect((await unchecked.json()).error).toContain("③ ② のうち除く患者等の数");
    const a = await (await save({ ...confirmed, stage2: { values, sources: auto, excludedChecked: true } })).json();
    expect(a.inputs.stage2.sources["excluded:U-33a=A:U-33b=A"]).toBe("auto");
    expect(a.stage2Open).toBe(true);
    expect(a.inputs.stage2.sources["c002:U-33a=A"]).toBe("auto");
    expect(a.inputs.stage2.sources["referral:U-32=A"]).toBe("manual");
    // 下書きの数を本人が直すと、印は手入力（自動の印を送っても、下書きと違う値は手入力）
    const b = await (await save({ ...confirmed, stage2: { values: { ...values, "care:U-33a=A:U-33c=A": 2 }, sources: auto, excludedChecked: true } })).json();
    expect(b.inputs.stage2.sources["care:U-33a=A:U-33c=A"]).toBe("manual");
    // 下書きの数と同じ値を 17j の形（印なし）で手で入れたときと結果が同じ
    const c = await (await save({ ...confirmed, stage2: { values } })).json();
    expect([c.result, c.splits, c.outcomes]).toEqual([a.result, a.splits, a.outcomes]);
    expect(Object.values(c.inputs.stage2.sources as Record<string, string>).every((x) => x === "manual")).toBe(true);
    // 記録と応答に、下書きに使った患者の目印の値が現れない
    const rows = JSON.stringify(dbRows("SELECT * FROM note14_worksheets")) + JSON.stringify(t) + JSON.stringify(a);
    for (const v of [P1.name, P1.birth, P1.no, P2.name, P2.birth, P2.no, P1.name.replace(/\s/g, "")]) expect(rows.includes(v), v).toBe(false);
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

describe("読めない請求を 0 と数えない（round-61 X-201・X-202・C-373）", () => {
  // 確認月 N と期間の 3 か月（ほかのテストの月と重ならない）
  const N = month(10);
  const [n1, n2, n3] = [month(7), month(8), month(9)];
  beforeAll(() => {
    setRole("manager");
    // 各月：在医総管の患者 A と、施医総管の患者 B・C・D。B・C・D のレセプトには未対応のレコード（読めない請求になる）
    const people = ["Ａ", "Ｂ", "Ｃ", "Ｄ"].map((x, i) => ({ name: `架空 読${x}`, birth: `193${i}0404`, no: `99000${i}` }));
    const file = {
      ...baseFile(),
      receipts: [n1, n2, n3].flatMap((m) => [
        receipt(m, [{ kubun: "C001_1I", count: 1, dates: [`${m}-06`] }, { kubun: "C002_2RO1", count: 1, dates: [`${m}-06`] }], people[0]),
        ...people.slice(1).map((p) => receipt(m, [{ kubun: "C001_1I", count: 1, dates: [`${m}-08`] }, { kubun: "C002-2_2RO1", count: 1, dates: [`${m}-08`] }], p)),
      ]),
    };
    // レセプトの添字：月ごとに 4 枚（0〜3, 4〜7, 8〜11）。B・C・D は 1・2・3 番目
    const raw = Object.fromEntries([0, 4, 8].flatMap((b) => [b + 1, b + 2, b + 3]).map((i) => [i, ["XX,unknown"]]));
    instance.runAs(owner, () => instance.getApp().uploadUke(instance.clerkIdOf(owner), ukeBytes(file, {}, raw)));
  });

  it("X-201：1 段目は読めない請求がある月を unreadable（何枚か）にし、確かめたことにはできない（400）", async () => {
    const t = await (await tool(`?month=${N}`)).json();
    expect(t.auto.map((a: { state: string; unreadable?: number }) => [a.state, a.unreadable])).toEqual([["unreadable", 3], ["unreadable", 3], ["unreadable", 3]]);
    expect(t.auto[0].text).toContain("読めない請求");
    expect((await save(body({}, [n1, n2, n3], N))).status).toBe(400);
  });

  it("X-202：2 段目の下書きは、読めない請求が 1 枚でもある月を使わず、どの月が何枚読めないかを出す", async () => {
    const t = await (await tool(`?month=${N}`)).json();
    expect(t.draft.ok).toBe(false);
    for (const m of [n1, n2, n3]) expect(t.draft.reason).toContain(`${m}（3 枚）`);
    expect(t.draft.reason).toContain("読めない請求");
  });
});
