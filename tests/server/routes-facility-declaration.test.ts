// 施設の申告のルート（GET・POST /api/facility/declaration、GET /api/facility/declaration/history、GET・POST /api/facility/declaration/confirm。
// design.md §15-2・§15-9 の段 17b・17c）。実際のルートを呼ぶ。AI は呼ばない
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { resolveRevision } from "../../src/engine/revisions";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import type { UkeFile } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";
import { day, month, YM } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");
let owner: User;
let cookie: string;

type Row = { id: number; itemKey: string; fromMonth: string | null; checkedBy: string; checkedOn: string | null; source: string; recheckOn: string | null; requirement: string; choice: string | null };
type Item = { key: string; row: Row | null; status: { v: string; reason: string | null } };
type Notice = { key: string; id: number; fromMonth: string; untilMonth: string | null; state: string };
type Decl = { today: string; items: Item[]; recheck: { rows: Notice[]; noFromMonth: string[] }; selectable: Row[]; initialSelection: number[]; mismatches: string[]; note14RecheckDefault: string };

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-declaration-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("decl_owner", "やまだ", "password123", "demo");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const URL_ = "http://localhost/api/facility/declaration";
const get = (c: string | null) => new Request(URL_, { headers: c ? { cookie: c } : {} });
const post = (c: string | null, body: unknown) => new Request(URL_, { method: "POST", headers: { ...(c ? { cookie: c } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
const routes = () => import("../../app/api/facility/declaration/route");
const historyRoute = () => import("../../app/api/facility/declaration/history/route");
const setRole = (u: User, role: Role) => instance.getAuth().switchRole(u, role);
const list = async (c = cookie) => (await (await (await routes()).GET(get(c))).json()) as Decl;
const save = async (body: unknown, c = cookie) => (await routes()).POST(post(c, body));
const code = (c: string, over: Record<string, unknown> = {}) => ({ item: `code:${c}`, fromMonth: YM, notified: "yes", requirement: "met", startOn: "2026-09-01", notifiedOn: null, choice: null, checkedOn: day(13), recheckOn: "2027-01-13", ...over });
const confirmRoute = () => import("../../app/api/facility/declaration/confirm/route");
const confirm = async (ids: number[], c = cookie) => (await confirmRoute()).POST(new Request(`${URL_}/confirm`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify({ ids }) }));
const selection = async (q: string) => ((await (await (await confirmRoute()).GET(new Request(`${URL_}/confirm?${q}`, { headers: { cookie } }))).json()) as { ids: number[] }).ids;
const historyOf = async (item: string) => ((await (await (await historyRoute()).GET(new Request(`${URL_}/history?item=${item}`, { headers: { cookie } }))).json()) as { rows: Row[] }).rows;
const itemOf = (d: Decl, key: string) => d.items.find((i) => i.key === key);

describe("施設の申告のルート", () => {
  it("未ログインは 401。読むのはどのロールも、残すのは事務長と責任者（事務・医師は 403 で何も残らない）", async () => {
    const { GET, POST } = await routes();
    expect((await GET(get(null))).status).toBe(401);
    expect((await POST(post(null, code("4102")))).status).toBe(401);
    const before = (await list()).items.find((i) => i.key === "code:4102")?.row?.id;
    for (const role of ["clerk", "doctor"] as const) {
      setRole(owner, role);
      expect([role, (await GET(get(cookie))).status]).toEqual([role, 200]);
      expect([role, (await save(code("4102"))).status]).toEqual([role, 403]);
    }
    setRole(owner, "veteran");
    expect((await save({ ...code("4102"), notified: "maybe" })).status).toBe(400);
    setRole(owner, "manager");
    expect(itemOf(await list(), "code:4102")?.row?.id).toBe(before);
  });

  it("形の違う入力は 400（知らない項目・在支病・種別で決まるコード・DX の区分なし・区分のある別コード・暦にない日・余計な欄）", async () => {
    setRole(owner, "manager");
    for (const body of [
      { ...code("4102"), item: "code:12345" },
      { ...code("4102"), item: "kyokagata" },
      code("3057"),
      code("4249"),
      code("3341"),
      code("3474"),
      code("3168"),
      // いつの診療月から（from_month）は、どの項目のどの行にも必須（P-2）
      code("4102", { fromMonth: undefined }),
      code("4102", { fromMonth: "" }),
      code("4102", { fromMonth: "2026-13" }),
      { item: "note16", requirement: "met", checkedOn: null, recheckOn: null },
      { item: "dispensing", choice: "inside", checkedOn: null, recheckOn: null },
      code("4100"),
      code("4102", { choice: "1" }),
      code("4102", { startOn: "2026-02-30" }),
      { ...code("4102"), claimId: "K1" },
      { item: "note16", fromMonth: YM, requirement: "yes", checkedOn: null, recheckOn: null },
      { item: "grade", fromMonth: YM, choice: "kyokagata", requirement: "met", startOn: null, notifiedOn: null, checkedOn: null, recheckOn: null },
    ]) expect([JSON.stringify(body), (await save(body)).status]).toEqual([JSON.stringify(body), 400]);
  });

  it("残すと前の行が変更の記録に残り、確かめた人はログインした利用者。監査ログには項目の鍵だけ", async () => {
    setRole(owner, "manager");
    const res = await save(code("4102", { requirement: "not_met" }));
    expect(res.status).toBe(200);
    const d = (await res.json()) as Decl;
    expect(itemOf(d, "code:4102")).toMatchObject({ row: { checkedBy: "やまだ", source: "input" }, status: { v: "not", reason: "要件を満たさない" } });
    const h = await (await historyRoute()).GET(new Request(`${URL_}/history?item=code:4102`, { headers: { cookie } }));
    const rows = ((await h.json()) as { rows: { source: string; requirement: string }[] }).rows;
    expect(rows.map((r) => [r.source, r.requirement])).toEqual([["input", "not_met"], ["seed", "met"]]);
    expect((await (await historyRoute()).GET(new Request(`${URL_}/history?item=../x`, { headers: { cookie } }))).status).toBe(400);
    const log = instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((l) => l.action === "POST /api/facility/declaration" && l.result === "ok");
    expect(log.map((l) => l.target)).toEqual(["code:4102"]);
  });

  it("確かめ直す日が近い（30 日以内）・過ぎた・ない申告の一覧（行ごと。項目と from_month）", async () => {
    setRole(owner, "manager");
    expect((await save(code("4307", { recheckOn: day(20) }))).status).toBe(200);
    expect((await save(code("721", { recheckOn: day(1) }))).status).toBe(200);
    expect((await save({ item: "note16", fromMonth: YM, requirement: "met", checkedOn: day(13), recheckOn: null })).status).toBe(200);
    // 30 日後ちょうどは「近い」、31 日後は入らない
    expect((await save({ item: "dispensing", fromMonth: YM, choice: "inside", checkedOn: day(13), recheckOn: "2026-11-12" })).status).toBe(200);
    expect((await save({ item: "grade", fromMonth: YM, choice: "zaishishin3", requirement: "met", startOn: "2026-09-01", notifiedOn: null, checkedOn: day(13), recheckOn: "2026-11-13" })).status).toBe(200);
    const d = await list();
    expect(d.today).toBe(day(13));
    // 種の行（from_month は最も早い版の開始月）は、10 月からの行が直後の組になり、その行を確かめた日（今日）より確かめ直す日が後なので出ない
    expect(d.recheck.rows.map((n) => [n.key, n.state, n.fromMonth, n.untilMonth]).sort()).toEqual(
      [["code:4307", "soon", YM, null], ["code:721", "overdue", YM, null], ["dispensing", "soon", YM, null], ["note16", "none", YM, null]].sort(),
    );
    expect(d.recheck.noFromMonth).toEqual([]);
    // 過ぎた申告と日付のない申告は「分からない」
    expect([itemOf(d, "code:721")?.status.v, itemOf(d, "note16")?.status.v, itemOf(d, "code:4307")?.status.v]).toEqual(["unknown", "unknown", "held"]);
  });

  it("合わない組み合わせは知らせるだけ（在支診（(3)）で在宅医療充実体制加算を持つ）", async () => {
    setRole(owner, "manager");
    expect((await list()).mismatches).toEqual([]);
    expect((await save(code("4248"))).status).toBe(200);
    expect((await list()).mismatches).toEqual(["在宅医療充実体制加算を持つと申告されていますが、種別が在支診（(3)）か在支診以外です"]);
  });
});

describe("まとめて「変わりなし」（docs M-5・round-52 X-150・round-53 C-274）", () => {
  it("知らせの行を選んだ状態で開き、確かめると同じ from_month の行が 1 行増え、確かめ直す日は項目ごとの既定（注16 は 3 か月後）。その月の判定が申告の値に戻る", async () => {
    setRole(owner, "manager");
    // 注16 に、前月からの行（確かめ直す日はずっと先）と、今月からの行（確かめ直す日を過ぎた）
    expect((await save({ item: "note16", fromMonth: month(-1), requirement: "met", checkedOn: day(1), recheckOn: "2027-01-31" })).status).toBe(200);
    expect((await save({ item: "note16", fromMonth: YM, requirement: "met", checkedOn: day(2), recheckOn: day(12) })).status).toBe(200);
    let d = await list();
    const notice = d.recheck.rows.find((n) => n.key === "note16")!;
    expect([notice.fromMonth, notice.state]).toEqual([YM, "overdue"]);
    expect(itemOf(d, "note16")?.status.reason).toBe("確かめ直す日を過ぎています");
    expect(await selection(`notice=${notice.id}`)).toEqual([notice.id]);
    const before = (await historyOf("note16")).length;
    const res = await confirm([notice.id]);
    expect(res.status).toBe(200);
    d = (await res.json()) as Decl;
    const rows = await historyOf("note16");
    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({ fromMonth: YM, requirement: "met", checkedOn: day(13), recheckOn: "2027-01-13", checkedBy: "やまだ", source: "input" });
    expect(itemOf(d, "note16")?.status.v).toBe("held");
    // 前月の行は増えない。前月の請求の比べる日は今月の組で最初に残した行の確かめた日（day(2)）のまま
    expect(rows.filter((r) => r.fromMonth === month(-1)).length).toBe(1);
  });

  it("選んだ行ごとに 1 行ずつ増え、from_month と値は選んだ行と同じ。種別・4100 でも同じ。確かめ直す日の既定は 1 年後", async () => {
    setRole(owner, "manager");
    const d = await list();
    const g = itemOf(d, "grade")!.row!;
    const dx = itemOf(d, "code:4100")!.row!;
    const res = await confirm([g.id, dx.id]);
    expect(res.status).toBe(200);
    const [g2] = await historyOf("grade");
    const [dx2] = await historyOf("code:4100");
    expect([g2.fromMonth, g2.choice, g2.recheckOn, dx2.fromMonth, dx2.choice, dx2.recheckOn]).toEqual([g.fromMonth, g.choice, "2027-10-13", dx.fromMonth, dx.choice, "2027-10-13"]);
  });

  it("同じ from_month の中で最新でない行の id は 409、ない id は 400、from_month が空の行は選べない。事務・医師は 403", async () => {
    setRole(owner, "manager");
    // 今月の組の、確かめ直しで写す前の行（その後に写した行がある）
    const old = (await historyOf("grade")).filter((r) => r.fromMonth === YM)[1];
    expect((await confirm([old.id])).status).toBe(409);
    expect((await confirm([999999])).status).toBe(400);
    expect((await confirm([])).status).toBe(400);
    setRole(owner, "clerk");
    expect((await confirm([(await historyOf("grade"))[0].id])).status).toBe(403);
    setRole(owner, "manager");
  });

  it("申告の画面の初期の選択は今日の前の月で効く行。判定の画面の理由からは、その診療月で効く行", async () => {
    setRole(owner, "manager");
    const d = await list();
    const prevNote16 = (await historyOf("note16")).find((r) => r.fromMonth === month(-1))!;
    expect(d.initialSelection).toContain(prevNote16.id);
    expect(d.selectable.map((r) => r.id)).toContain(prevNote16.id);
    expect(await selection(`month=${month(-1)}&item=note16`)).toEqual([prevNote16.id]);
  });
});

describe("実在用のクリニック", () => {
  it("申告がなければ、種別・注16・DX・ベースアップは分からない（config の既定値を使わない）", async () => {
    const real = instance.getAuth().register("decl_real", "さとう", "password123", "real");
    const realCookie = `resemen_session=${instance.getAuth().createSession(real.id).token}`;
    const C = resolveRevision("2026-10").consts;
    const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
    const r = base.receipts[0];
    const file: UkeFile = { ...base, receipts: [{ ...r, claimId: "A1", patient: { ...r.patient, name: "架空 梅子", birth: "19480808", insurer: { number: "06139991", symbol: "77", no: "702" } }, lines: [{ kubun: C.visitKubun[0], count: 1, dates: [day(5)] }], comments: [] }] };
    const id = instance.runAs(real, () => instance.getApp().uploadUke(instance.clerkIdOf(real), writeUke(file)).flatMap((u) => u.receipts.map((x) => x.claimId)))[0];
    const f = instance.runAs(real, () => instance.getApp().caseOf(id).facility);
    expect([f.grade, f.note16Met, f.dxTier, f.baseUp]).toEqual([{ known: false }, { known: false }, { known: false }, { known: false }]);
    // 種別の申告がないので、在支診か・機能強化型か・病床も分からない（config の値が残らない）
    expect([f.zaishishin, f.kyokagata, f.hasBeds]).toEqual([null, null, null]);
    const d = await list(realCookie);
    expect(d.items.every((i) => i.row === null && i.status.v === "unknown")).toBe(true);
    expect(itemOf(d, "grade")?.status.reason).toBe("申告がありません");
    // 申告に移さない設定（物価対応料・同じ日の重ね）も、設定の画面で残すまで分からない（config の既定値を使わない。code H-1）
    expect([f.priceResponse, f.revisitBaseUpSameDay, f.revisitPriceSameDay]).toEqual([{ known: false }, { known: false }, { known: false }]);
    setRole(real, "manager");
    const fr = await import("../../app/api/facility/route");
    const saved = await fr.POST(new Request("http://localhost/api/facility", { method: "POST", headers: { cookie: realCookie, "content-type": "application/json" }, body: JSON.stringify({ key: "priceResponse", value: true }) }));
    expect(saved.status).toBe(200);
    expect(instance.runAs(real, () => instance.getApp().caseOf(id).facility).priceResponse).toEqual({ known: true, value: true });
  });
});

describe("同じ建物で 2 人以上を診ている建物があるか（building。段 17f。C-242）", () => {
  it("from_month のない申告は 400。残すと効く行が 15-2 の規則で決まり、申告だけから 1 人と決まる請求の 2 人以上の区分の行は、申告の画面に数が出て、R19 は食い違いの情報不足にする", async () => {
    const real = instance.getAuth().register("decl_building", "すずき", "password123", "real");
    const c = `resemen_session=${instance.getAuth().createSession(real.id).token}`;
    setRole(real, "manager");
    expect((await save({ item: "building", choice: "none", checkedOn: day(13), recheckOn: "2027-10-13" }, c)).status).toBe(400);
    expect((await save({ item: "building", fromMonth: YM, choice: "several", checkedOn: day(13), recheckOn: "2027-10-13" }, c)).status).toBe(400);
    const C = resolveRevision(YM).consts;
    const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
    const r = base.receipts[0];
    const file: UkeFile = { ...base, receipts: [{ ...r, claimId: "B1", patient: { ...r.patient, name: "架空 松子", birth: "19470707", insurer: { number: "06139991", symbol: "77", no: "703" } }, lines: [{ kubun: C.visitKubun[0], count: 2, dates: [day(5), day(19)] }, { kubun: "C002_2RO2", count: 1, dates: [day(19)] }], comments: [] }] };
    const id = instance.runAs(real, () => instance.getApp().uploadUke(instance.clerkIdOf(real), writeUke(file)).flatMap((u) => u.receipts.map((x) => x.claimId)))[0];
    // 申告がない間は分からない（患者ごとの値もないので、R19 は人数の情報不足）
    expect(instance.runAs(real, () => instance.getApp().caseOf(id).facility.building)).toEqual({ known: false });
    expect((await list(c)).mismatches).toEqual([]);
    // 来月からの「ない」は、今月の請求に効かない
    expect((await save({ item: "building", fromMonth: month(1), choice: "none", checkedOn: day(13), recheckOn: "2027-10-13" }, c)).status).toBe(200);
    expect(instance.runAs(real, () => instance.getApp().caseOf(id).facility.building)).toEqual({ known: false });
    expect((await save({ item: "building", fromMonth: YM, choice: "none", checkedOn: day(13), recheckOn: "2027-10-13" }, c)).status).toBe(200);
    const d = await list(c);
    expect(itemOf(d, "building")?.status.v).toBe("held");
    expect(d.mismatches).toEqual(["同じ建物で 2 人以上を診ている建物は「ない」と申告されていますが、2 人以上の区分の管理料の行がある請求が 1 件あります"]);
    const claim = instance.runAs(real, () => instance.getApp().caseOf(id));
    expect(claim.facility.building).toEqual({ known: true, value: "none" });
    expect(claim.facilityBasis?.building).toBe("declaration");
    const fs = evaluate(claim).findings.filter((f) => f.ruleId === "R19");
    expect(fs.map((f) => [f.messageKey, f.missing?.field])).toEqual([["R19.declaration_conflict", "facility.building"]]);
    // 変更の記録の問い（history）も building を受ける
    expect((await (await historyRoute()).GET(new Request(`${URL_}/history?item=building`, { headers: { cookie: c } }))).status).toBe(200);
  });
});

describe("注14 の申告（note14。段 17h）", () => {
  it("building が「ない」の施設には欄を出さず、請求に 10 人以上の区分の行が出たときだけ「注14 を入れてください」。from_month のない申告は 400。確かめ直す日を過ぎた行は分からないになり、「変わりなし」で残すと情報不足が消える（C-320 のうち道具の結果に依らない部分）", async () => {
    const real = instance.getAuth().register("decl_note14", "たなか", "password123", "real");
    const c = `resemen_session=${instance.getAuth().createSession(real.id).token}`;
    setRole(real, "manager");
    expect((await save({ item: "building", fromMonth: YM, choice: "none", checkedOn: day(13), recheckOn: "2027-10-13" }, c)).status).toBe(200);
    expect(itemOf(await list(c), "note14")).toBeUndefined();
    const C = resolveRevision(YM).consts;
    const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
    const r = base.receipts[0];
    const file: UkeFile = { ...base, receipts: [{ ...r, claimId: "N1", patient: { ...r.patient, name: "架空 竹子", birth: "19460606", insurer: { number: "06139991", symbol: "77", no: "704" } }, lines: [{ kubun: C.visitKubun[0], count: 2, dates: [day(5), day(19)] }, { kubun: "C002_2RO3", count: 1, dates: [day(19)] }], comments: [] }] };
    const id = instance.runAs(real, () => instance.getApp().uploadUke(instance.clerkIdOf(real), writeUke(file)).flatMap((u) => u.receipts.map((x) => x.claimId)))[0];
    let d = await list(c);
    expect(d.mismatches).toContain("注14 を入れてください（10 人以上の区分の管理料の行がある請求があります）：1 件");
    expect(itemOf(d, "note14")?.status.v).toBe("unknown");
    // 形：from_month が要る。届出日・算定開始年月日は減算のときだけ
    const n14 = (o: Record<string, unknown>) => ({ item: "note14", fromMonth: YM, choice: "normal", notifiedOn: null, startOn: null, checkedOn: day(1), recheckOn: day(10), ...o });
    expect((await save(n14({ fromMonth: undefined }), c)).status).toBe(400);
    expect((await save(n14({ startOn: "2026-10-01" }), c)).status).toBe(400);
    // 確かめ直す日（10 日）を過ぎた「通常」：その月の 10 人以上の区分の行に情報不足（確かめ直す日を過ぎた）
    expect((await save(n14({}), c)).status).toBe(200);
    const judged = () => evaluate(instance.runAs(real, () => instance.getApp().caseOf(id))).findings.filter((f) => f.missing?.field === "facility.note14").map((f) => f.ruleId);
    expect(judged()).toEqual(["R18"]);
    d = await list(c);
    expect(itemOf(d, "note14")?.status.reason).toBe("確かめ直す日を過ぎています");
    expect(d.note14RecheckDefault).toBe("2027-02-28");
    // 「変わりなし」で残すと（確かめ直す日は次の確認月の末日）、同じ点検で情報不足が消える。応答は行ごと
    const note14Row = itemOf(d, "note14")!.row!;
    const res = await confirm([note14Row.id], c);
    expect(res.status).toBe(200);
    const after = (await res.json()) as Decl & { results: { id: number; ok: boolean }[] };
    expect(after.results).toEqual([{ id: note14Row.id, ok: true }]);
    expect(itemOf(after, "note14")?.row?.recheckOn).toBe("2027-02-28");
    expect(judged()).toEqual([]);
    // 減算なら、届出日と算定開始年月日を記録として残せる（判定は from_month）
    expect((await save(n14({ choice: "reduced", startOn: "2026-10-01", notifiedOn: "2026-09-20", recheckOn: "2027-02-28" }), c)).status).toBe(200);
    expect(instance.runAs(real, () => instance.getApp().caseOf(id)).facility.note14).toEqual({ known: true, value: "減算" });
  });
});
