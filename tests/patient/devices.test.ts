// 段 19e（design.md §16-5・16-4-7・16-7・16-8）：患者の在宅療養の機器。DEVICE_KINDS・DEVICE_UNITS と EM の行、効く行の選び方、「機器なし」、
// 電子カルテからの変える案（確かめるまで判定に使わない・入れる／入れない・C150 は区分を選ばないと受けない）、マイグレーション 19。AI は呼ばない。
// 材料加算の候補の升（T8〜T15）と、確かめていない患者の「見ていません」と案内は tests/generic/g11-structured.test.ts（升の id つき）
import Database from "better-sqlite3";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StructuredChart } from "../../src/connect/types";
import { APP_MIGRATIONS, migrate } from "../../src/db/migrate";
import type { User } from "../../src/server/auth";
import { codeOfDevice, DEVICE_KINDS, DEVICE_UNITS, effectiveDevices, MATERIAL_MONTH_COMMENTS, proposalsOf, unitOfDevice, type DeviceRow } from "../../src/structured/devices";
import { autoConsent } from "../helpers/consent";
import { claimId, month, YM } from "../helpers/period";

vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), () => ({ structured: null })));

const em = readFileSync(path.join(__dirname, "..", "..", "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8").split("\n");
const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
const emRow = (id: string) => cells(em.find((l) => l.startsWith(`| ${id} |`))!);

describe("DEVICE_UNITS・対象の月のコメントと EM", () => {
  it("DEVICE_UNITS の単位は EM の行（R8-221・R8-226・R8-216 の (b)(c)）と合い、単位の機器の種類は DEVICE_KINDS の EM の行と同じ", () => {
    expect(Object.keys(DEVICE_UNITS).sort()).toEqual(["人工呼吸器", "血糖自己測定器", "酸素の組 (b)", "酸素の組 (c)"].sort());
    for (const [name, u] of Object.entries(DEVICE_UNITS)) for (const k of u.kinds) expect([name, k, DEVICE_KINDS[k].em]).toEqual([name, k, u.em === "R8-216" ? DEVICE_KINDS[k].em : u.em]);
    // 人工呼吸器は「いずれか 1 つ」、C150 は 1 つの区分キー（段と患者の区分を行に持つ）
    expect(emRow("R8-226")[3]).toContain("いずれか 1 つ");
    expect(DEVICE_UNITS.人工呼吸器.kinds).toEqual(["C164_1", "C164_2", "C164_3"]);
    // 酸素の組：(b) ボンベ（携帯用以外）・濃縮装置・設置型液化酸素装置、(c) 携帯用ボンベと携帯型液化酸素装置（R8-216）
    const r216 = emRow("R8-216")[3];
    expect(r216).toContain("(b) ボンベ（携帯用以外）・濃縮装置・設置型液化酸素装置を併用したときは、**合わせて 3 月に 3 回**");
    expect(r216).toContain("(c) 携帯用ボンベと携帯型液化酸素装置を併用したときも**合わせて 3 月に 3 回**");
    expect(DEVICE_UNITS["酸素の組 (b)"].kinds.map((k) => DEVICE_KINDS[k].em)).toEqual(["R8-211", "R8-23", "R8-212"]);
    expect(DEVICE_UNITS["酸素の組 (c)"].kinds.map((k) => DEVICE_KINDS[k].em)).toEqual(["R8-24", "R8-213"]);
    // 単位にない機器は自分のコードだけ
    expect(unitOfDevice("C160")).toEqual({ name: null, codes: ["114005110"] });
    expect(unitOfDevice("C158").codes.sort()).toEqual(["114006110", "114006210", "114004910"].sort());
  });
  it("対象の月のコメント（820100122〜126）は EM §2-10 表 1-b の行と 1 対 1", () => {
    const start = em.findIndex((l) => l.startsWith("表 1-b　材料加算の 2 回分・3 回分の対象の月"));
    const rows = em.slice(start, start + 20).filter((l) => /^\| 8201001\d\d \|/.test(l)).map(cells);
    const shift: Record<string, number> = { m: 0, "m の翌月": 1, "m の翌々月": 2, "m の前月": -1, "m の前々月": -2 };
    expect(Object.fromEntries(rows.map((c) => [c[0], shift[c[3]]]))).toEqual(MATERIAL_MONTH_COMMENTS);
  });
});

const row = (seq: number, kind: DeviceRow["kind"], fromMonth: string, endMonth: string | null = null, more: Partial<DeviceRow> = {}): DeviceRow => ({ seq, kind, fromMonth, endMonth, source: "医療事務が入れた", checkedBy: "たいおう", checkedAt: "x", ...more });

describe("効く行の選び方（16-5）", () => {
  it("種類ごとに fromMonth がその月以前で最も新しい行（同じ月なら追記の順が後）で、endMonth が空かその月以後のもの", () => {
    const rows = [row(1, "C158", month(-3)), row(2, "C160", month(-3)), row(3, "C158", month(-3), month(-1))];
    expect(effectiveDevices(rows, month(-1)).rows.map((r) => r.kind)).toEqual(["C158", "C160"]);
    expect(effectiveDevices(rows, YM).rows.map((r) => r.kind)).toEqual(["C160"]);
    expect(effectiveDevices(rows, month(-4))).toEqual({ checked: false, rows: [] });
  });
  it("10 月から終わりなしの C158 に 11 月から「機器なし」を足すと、11 月は C158 が効かず 10 月は効く。そのあと 12 月から C159_1 を足すと 12 月はそれだけが効く（X-233）", () => {
    const [m10, m11, m12] = [YM, month(1), month(2)];
    const rows = [row(1, "C158", m10), row(2, "none", m11)];
    expect(effectiveDevices(rows, m10).rows.map((r) => r.kind)).toEqual(["C158"]);
    expect(effectiveDevices(rows, m11)).toEqual({ checked: true, rows: [] });
    rows.push(row(3, "C159_1", m12));
    expect(effectiveDevices(rows, m12).rows.map((r) => r.kind)).toEqual(["C159_1"]);
    expect(effectiveDevices(rows, m11).rows).toEqual([]);
  });
  it("C150 は段と患者の区分で 1 つのコード。区分がなければ決めない", () => {
    expect(codeOfDevice({ kind: "C150", c150: { band: "C150_2", patientClass: "イ" } })).toBe("114046010");
    expect(codeOfDevice({ kind: "C150", c150: { band: "C150_6", patientClass: "ロ" } })).toBe("114015610");
    expect(codeOfDevice({ kind: "C150" })).toBeNull();
  });
  it("変える案は、今の効く行と違うものだけ（新しい機器・終わりのある機器・効く行にあって指示にない機器・種類の決まらない機器）", () => {
    const live = [{ kind: "C158" as const }, { kind: "C160" as const }];
    const props = proposalsOf(
      [
        { kind: "C158", name: null, startedOn: null, endedOn: null, ref: "h1/0" },
        { kind: "C161", name: null, startedOn: `${YM}-01`, endedOn: null, ref: "h1/1" },
        { kind: "C160", name: null, startedOn: null, endedOn: `${YM}-20`, ref: "h1/2" },
        { kind: null, name: "独自の機器", startedOn: null, endedOn: null, ref: "h1/3" },
      ],
      live,
    );
    expect(props.map((p) => [p.kind, p.ref])).toEqual([["C161", "h1/1"], ["C160", "h1/2"], [null, "h1/3"]]);
    expect(proposalsOf([], live).map((p) => p.ref)).toEqual(["指示になし:C158", "指示になし:C160"]);
  });
});

describe("マイグレーション 19（design.md §16-8）", () => {
  it("18 まで当てた DB に当たり、表が 2 つ増え、今の行は残る。もう一度当てても変わらない", () => {
    const db = new Database(":memory:");
    migrate(db, APP_MIGRATIONS.slice(0, 18));
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('now', 'x')").run();
    expect(APP_MIGRATIONS[18].version).toBe(19);
    expect(migrate(db, APP_MIGRATIONS.slice(0, 19))).toBe(19);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("patient_devices")).toEqual(["id", "patient_id", "kind", "from_month", "end_month", "detail", "source", "checked_by", "checked_at"]);
    expect(cols("device_proposals")).toEqual(["id", "patient_id", "kind", "started_on", "ended_on", "ref", "connector_id", "received_at", "decision", "decided_by", "decided_at"]);
    const before = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    expect(migrate(db, APP_MIGRATIONS.slice(0, 19))).toBe(19);
    expect(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'now'").get()).toEqual({ value: "x" });
  });
});

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-devices-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("devices_routes", "たいおう", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});
const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url: string) => new Request(`http://localhost${url}`, { headers: { cookie } });
const app = () => instance.getApp();
const as = <T,>(fn: () => T) => instance.runAs(user, fn);
const UNS = { status: "unsupported" as const };
const homeCare = (devices: { code: string; endedOn?: string }[]): StructuredChart => ({
  visits: UNS,
  orders: UNS,
  procedures: UNS,
  homeCare: { status: "supported", gaps: {}, items: [{ ref: "h1", kind: { code: { system: "rece", value: "114003710" }, name: null }, startedOn: null, devices: devices.map((d) => ({ code: { system: "rece", value: d.code }, name: null, startedOn: `${month(-1)}-01`, endedOn: d.endedOn ?? null })) }] },
});
type View = { checked: boolean; live: { kind: string; fromMonth: string; source: string }[]; history: unknown[]; proposals: { id: number; kind: string | null; type: string }[] };

describe("患者の機器の画面と API（16-5・16-7）", () => {
  const K = claimId("K1");
  it("変える案は確かめるまで判定に使われず、入れると行が追記され、入れないと同じ案は出ない。C150 の案は区分を選ばないと 400（X-253）", async () => {
    const { GET, POST } = await import("../../app/api/patient/devices/route");
    const { POST: DECIDE } = await import("../../app/api/patient/device-proposals/[id]/route");
    const view = async () => (await (await GET(get(`/api/patient/devices?claimId=${K}`))).json()) as View;
    const pid = as(() => app().structuredPatientOf(K));
    // 電子カルテの指示：C150（30 回以上 イ）と C158
    as(() => app().saveStructured(pid, YM, "fixture", homeCare([{ code: "114046010" }, { code: "114006210" }])));
    let v = await view();
    expect(v.checked).toBe(false);
    expect(v.live).toEqual([]);
    expect(v.proposals.map((p) => [p.kind, p.type])).toEqual([["C150", "start"], ["C158", "start"]]);
    // 確かめるまで判定に使わない（G11 の入力の効く行は空で、案の種類だけが添え書きに使われる）
    expect(as(() => app().devices.deviceInputOf(pid, YM))).toEqual({ checked: false, rows: [], pending: ["C150", "C158"] });
    const [c150, c158] = v.proposals;
    const decide = (id: number, body: object) => DECIDE(post(`/api/patient/device-proposals/${id}`, { claimId: K, ...body }), { params: Promise.resolve({ id: String(id) }) });
    // C150 は測定回数の区分と患者の区分がないと受けない
    const bad = await decide(c150.id, { action: "accept" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("血糖自己測定器は、測定回数の区分と患者の区分（イ／ロ）を選んでください");
    expect((await decide(c150.id, { action: "accept", c150: { band: "C150_2", patientClass: "イ" } })).status).toBe(200);
    // 入れない
    expect((await decide(c158.id, { action: "reject" })).status).toBe(200);
    v = await view();
    expect(v.live.map((r) => [r.kind, r.fromMonth, r.source])).toEqual([["C150", month(-1), "電子カルテ（確かめた）"]]);
    expect(v.proposals).toEqual([]);
    const input = as(() => app().devices.deviceInputOf(pid, YM));
    expect(input.rows).toEqual([{ kind: "C150", fromMonth: month(-1), c150: { band: "C150_2", patientClass: "イ" }, source: "電子カルテ（確かめた）" }]);
    // 候補のコードは 1 つに決まる
    expect(codeOfDevice(input.rows[0])).toBe("114046010");
    // 同じ指示が次に届いても、入れない案と、入れて効く行と同じ機器は出ない
    as(() => app().saveStructured(pid, YM, "fixture", homeCare([{ code: "114046010" }, { code: "114006210" }])));
    expect((await view()).proposals).toEqual([]);
    // 違う中身（終わりの日がある）は出す
    as(() => app().saveStructured(pid, YM, "fixture", homeCare([{ code: "114046010", endedOn: `${YM}-20` }, { code: "114006210" }])));
    expect((await view()).proposals.map((p) => [p.kind, p.type])).toEqual([["C150", "end"]]);
  });
  it("医療事務が機器の行と「機器なし」を入れられる。種類は DEVICE_KINDS のキーか none、C150 は区分が要る。監査ログは種類の鍵だけ", async () => {
    const { GET, POST } = await import("../../app/api/patient/devices/route");
    const K2 = claimId("K2");
    expect((await POST(post("/api/patient/devices", { claimId: K2, kind: "C999", fromMonth: YM }))).status).toBe(400);
    expect((await POST(post("/api/patient/devices", { claimId: K2, kind: "C150", fromMonth: YM }))).status).toBe(400);
    expect((await POST(post("/api/patient/devices", { claimId: K2, kind: "C160", fromMonth: month(-2) }))).status).toBe(200);
    expect((await POST(post("/api/patient/devices", { claimId: K2, kind: "none", fromMonth: YM }))).status).toBe(200);
    const v = (await (await GET(get(`/api/patient/devices?claimId=${K2}`))).json()) as View;
    expect(v.checked).toBe(true);
    expect(v.live).toEqual([]);
    expect(v.history).toHaveLength(2);
    const audit = as(() => app().audit.list()) as { action: string; target: string | null }[];
    const mine = audit.filter((a) => a.action === "POST /api/patient/devices").map((a) => a.target);
    expect(mine).toContain("C160");
    expect(mine.every((t) => t === null || /^(C\d{3}[\w-]*|none)$/.test(t) || t === "C999")).toBe(true);
  });
});
