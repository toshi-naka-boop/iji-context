// 取り込んだファイルを消す（design.md §11-11「消す」。完了条件 (d) と (g) の後半）。実際のルート（DELETE /api/uke/uploads/[sha256]）を呼び、
// 消したあとに DB の全表を走査して、その請求 id・患者 id が監査ログ以外に残っていないことを確かめる。AI は呼ばない（SDK を差し替える）
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import type { Role } from "../../src/server/roles";
import type { UkeFile, UkePatient } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";
import { claimId, day } from "../helpers/period";

/** deleted＝消したセッション／listed＝SDK がその作業場所のものとして挙げるセッション（DB に id のないもの）／hold＝メンターの応答を保留する（返事の前に呼ばれる） */
const sdk = vi.hoisted(() => ({ deleted: [] as { id: string; dir?: string }[], listed: [] as { id: string; dir: string }[], hold: null as null | ((call: { options: Record<string, unknown> }) => Promise<void>) }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await import("../helpers/sdk")).fakeSdk(await original<object>(), async (call) => {
    await sdk.hold?.(call);
    return { structured: { body: "見るとよい場所があります。", expression: "通常", citedKnowledge: [], topic: "算定" } };
  }),
  deleteSession: async (id: string, o?: { dir?: string }) => void sdk.deleted.push({ id, dir: o?.dir }),
  listSessions: async (o?: { dir?: string }) => sdk.listed.filter((s) => s.dir === o?.dir).map((s) => ({ sessionId: s.id })),
}));

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-erase-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  vi.spyOn(console, "info").mockImplementation(() => {});
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const auth = () => instance.getAuth();
const cookieOf = (u: User) => `resemen_session=${auth().createSession(u.id).token}`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const del = async (cookie: string | null, sha256: string) =>
  (await import("../../app/api/uke/uploads/[sha256]/route")).DELETE(new Request(`http://localhost/api/uke/uploads/${sha256}`, { method: "DELETE", headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ sha256 }) });

/** DB の全表の中身（表の名前 → 行を JSON にした文）。監査ログを除く */
function dump(dbFile: string): Record<string, string> {
  const db = new Database(dbFile, { readonly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("audit_log");
    return Object.fromEntries(tables.filter((t) => t !== "audit_log").map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())]));
  } finally {
    db.close();
  }
}
/** id がその文に（ほかの id の一部としてではなく）現れるか */
const has = (text: string, id: string) => new RegExp(`(?<![A-Za-z0-9-])${id}(?![A-Za-z0-9-])`).test(text);
const tablesWith = (tables: Record<string, string>, id: string) => Object.keys(tables).filter((t) => has(tables[t], id));

describe("取り込んだファイルを消す", () => {
  it("消したあと、その請求 id・患者 id が監査ログ以外のどの表にも残らない。同じファイルの別の患者は一緒に消え、別のファイルの同じ患者は残る。連番は使い回さない", async () => {
    const owner = auth().register("erase_owner", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const me = instance.clerkIdOf(owner);
    const setRole = (role: Role) => auth().switchRole(owner, role);
    const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
    const k6 = base.receipts[0];
    const person = (name: string, no: string): UkePatient => ({ ...k6.patient, name, birth: "19480808", insurer: { number: "06139991", symbol: "77", no } });
    const both = person("架空 両方", "501"); // 2 つのファイルの両方にいる患者
    const only = person("架空 片方", "502"); // 消すファイルにだけいる患者
    const fileA: UkeFile = { ...base, receipts: [{ ...k6, claimId: "A1", patient: both }, { ...k6, claimId: "A2", patient: only }] };
    const fileB: UkeFile = { ...base, clinic: { ...base.clinic, name: "架空在宅診療所" }, receipts: [{ ...k6, claimId: "A1", patient: both }] };
    const [bytesA, bytesB] = [writeUke(fileA), writeUke(fileB)];
    const dbFile = instance.tenantPaths(owner.tenantId).dbFile;
    const workspace = path.join(tmp, "ws", owner.tenantId, me);

    // 取り込み、消すファイル（U1）と残すファイル（U2）の請求に、ぶら下がる記録をひととおり作る
    const made = await instance.runAs(owner, async () => {
      const a = instance.getApp();
      // 前に使って捨てたセッション（同期の世代が変わる前のもの）。このあとの相談で、いまのセッションは s-test に替わる
      a.setSession(me, "s-old");
      a.uploadUke(me, bytesA);
      a.uploadUke(me, bytesB);
      expect(a.importedClaims(me)).toEqual(["U1-1", "U1-2", "U2-1"]);
      const out: Record<string, string> = {};
      for (const id of ["U1-1", "U1-2", "U2-1"]) {
        // 処理体験（問題）→ 提出・適用記録 → 提出結果
        const q = a.start(me, id);
        a.draft(q.id, a.caseFor(q).lines);
        a.confirm(q.id, a.caseFor(q).lines);
        a.importClaimResult({ resultId: `r-${id}`, submissionId: q.id, kind: "原審査", outcome: "査定", kubun: [a.caseFor(q).lines[0].kubun] });
        // メンターとのやり取り（セッション・作業場所・雑談の回数）と、ベテランへの問い
        await instance.talkToMentor({ user: owner, clerkId: me, questionId: q.id, message: "ヒントをください", situation: "通常" });
        a.peerToHuman(me, `${id} のことで、院内ではどうしていますか`, id);
        // 医師確認、確かめた患者情報、加入情報の確認
        out[`query:${id}`] = a.proxySubmit(id, "下書き", { text: "整えた文", missing: [] }).query!.id;
        a.savePatientFact(id, me, { key: "table7", value: true, source: "カルテ", validUntil: null });
        // 請求ごとに確かめた事実（日付ごとの事実と、そうでない事実）
        a.saveClaimFact(id, me, "clerk", { key: "sameDayOushinAfterVisit", date: day(5), value: true, source: "カルテ" });
        a.saveClaimFact(id, me, "clerk", { key: "dischargeJointGuidance", date: null, value: true, source: "カルテ" });
        a.confirmCoverage(id, me, { coverageId: a.patientProfile(id).coverages[0].coverageId, source: "保険証・資格確認書" });
        out[`patient:${id}`] = a.patientFacts(id).patientId;
        out[`question:${id}`] = q.id;
      }
      a.runMeeting();
      return out;
    });
    // 訪問カルテは、取り込んだ請求には画面から書けない。表に行があっても消えることを確かめるため、行を直接入れる
    const raw = new Database(dbFile);
    for (const id of ["U1-1", "U2-1"]) raw.prepare("INSERT INTO chart_notes (claim_id, date, kind, note, facts, clerk_id, created_at) VALUES (?, ?, '訪問診療', '{}', NULL, ?, ?)").run(id, day(5), me, new Date().toISOString());
    raw.close();
    expect(made["patient:U1-1"]).toBe(made["patient:U2-1"]);
    expect(made["patient:U1-2"]).not.toBe(made["patient:U1-1"]);
    const [stays, goes] = [made["patient:U1-1"], made["patient:U1-2"]];

    // 走査が効いていること：消す前は、請求 id・患者 id がいくつもの表にある
    const before = dump(dbFile);
    expect(tablesWith(before, "U1-1")).toEqual(expect.arrayContaining(["chart_notes", "claim_facts", "peer_questions", "questions", "submissions"]));
    expect(tablesWith(before, made["question:U1-1"])).toEqual(expect.arrayContaining(["applications", "claim_results", "questions", "submissions"]));
    expect(tablesWith(before, goes)).toEqual(expect.arrayContaining(["patient_coverages", "patient_facts", "patients"]));
    const queryFiles = () => readdirSync(instance.tenantPaths(owner.tenantId).queryLogDir);
    expect(queryFiles().filter((f) => f.startsWith(made["query:U1-1"]))).toHaveLength(2);
    const ukeDir = path.join(path.dirname(dbFile), "uke");
    expect(readdirSync(ukeDir).sort()).toEqual([`${sha(bytesA)}.UKE`, `${sha(bytesB)}.UKE`].sort());
    expect(existsSync(path.join(workspace, "CLAUDE.md"))).toBe(true);
    const sessionBefore = instance.runAs(owner, () => instance.getApp().clerk(me).session_id);
    expect(sessionBefore).toBe("s-test");
    expect(JSON.parse(before.clerk_sessions)).toEqual([{ clerk_id: me, session_id: "s-old" }, { clerk_id: me, session_id: "s-test" }]);
    // 失敗した呼び出しが残した記録（id が DB にない）も、SDK がその作業場所のものとして挙げれば消す。ほかの人の作業場所のものは消さない
    sdk.listed.push({ id: "s-orphan", dir: workspace }, { id: "s-other", dir: path.join(tmp, "ws", owner.tenantId, "someone-else") });

    // 権限：未ログインは 401、事務・医師は 403、形の違う指定は 400、取り込んでいないハッシュは 404。何も消えない
    expect((await del(null, sha(bytesA))).status).toBe(401);
    for (const role of ["clerk", "doctor"] as const) {
      setRole(role);
      expect([role, (await del(cookie, sha(bytesA))).status]).toEqual([role, 403]);
    }
    setRole("manager");
    expect((await del(cookie, "../../etc/passwd")).status).toBe(400);
    expect((await del(cookie, "0".repeat(64))).status).toBe(404);
    expect(dump(dbFile)).toEqual(before);

    // 事務長が消す。返るのは件数だけ
    const res = await del(cookie, sha(bytesA));
    expect([res.status, await res.json()]).toEqual([200, { deleted: sha(bytesA), claims: 2 }]);
    expect((await del(cookie, sha(bytesA))).status).toBe(404);

    // 全表の走査：消したファイルの請求 id・問題（提出）の id・そのファイルにだけいた患者の id が、どの表にもない
    const after = dump(dbFile);
    for (const id of ["U1-1", "U1-2", made["question:U1-1"], made["question:U1-2"], goes, sha(bytesA)]) expect([id, tablesWith(after, id)]).toEqual([id, []]);
    // 別のファイルの請求と、そこに残る患者（消したファイルにもいた人）は残る
    expect(tablesWith(after, "U2-1")).toEqual(expect.arrayContaining(["chart_notes", "claim_facts", "peer_questions", "questions", "submissions"]));
    expect(tablesWith(after, stays)).toEqual(expect.arrayContaining(["patient_coverages", "patient_facts", "patients"]));
    // ファイル：原本、医師確認の記録、メンターの作業場所とやり取り
    expect(readdirSync(ukeDir)).toEqual([`${sha(bytesB)}.UKE`]);
    expect(queryFiles().filter((f) => f.startsWith(made["query:U1-1"]) || f.startsWith(made["query:U1-2"]))).toEqual([]);
    expect(queryFiles().filter((f) => f.startsWith(made["query:U2-1"]))).toHaveLength(2);
    expect(queryFiles().map((f) => readFileSync(path.join(instance.tenantPaths(owner.tenantId).queryLogDir, f), "utf8")).some((t) => has(t, "U1-1") || has(t, "U1-2"))).toBe(false);
    expect(existsSync(workspace)).toBe(false);
    // メンターのやり取り：いまのセッションだけでなく、前に使って捨てたセッションと、DB に id のない記録も消える（S-6）
    expect(sdk.deleted).toEqual([{ id: "s-old", dir: workspace }, { id: "s-test", dir: workspace }, { id: "s-orphan", dir: workspace }]);
    expect(after.clerk_sessions).toBe("[]");
    // 監査ログには、内容のハッシュだけが残る
    const log = instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((l) => l.action === "DELETE /api/uke/uploads/[sha256]");
    expect(log.filter((l) => l.result === "ok")).toMatchObject([{ target: sha(bytesA), status: 200, role: "manager" }]);
    expect(JSON.stringify(log)).not.toMatch(/架空|06139991|U1-1/);

    await instance.runAs(owner, async () => {
      const a = instance.getApp();
      expect(a.clerk(me).session_id).toBeNull();
      expect(a.importedClaims(me)).toEqual(["U2-1"]);
      expect(a.cases().map((c) => c.claimId).filter((id) => id.startsWith("U"))).toEqual(["U2-1"]);
      expect(a.doctorQueries().map((q) => q.claimId)).toEqual(["U2-1"]);
      expect(a.patientFacts("U2-1")).toMatchObject({ patientId: stays, facts: [{ key: "table7" }] });
      expect(a.claimFacts("U2-1").facts.map((f) => f.key)).toEqual(["sameDayOushinAfterVisit", "dischargeJointGuidance"]);
      // 残った請求は、今までどおり点検できる。同梱の症例も動く
      const q = a.start(me, "U2-1");
      expect(a.confirm(q.id, a.caseFor(q).lines).confirmed).not.toBeNull();
      expect(a.caseOf(claimId("K1")).claimId).toBe(claimId("K1"));
      // 消したファイルを取り込み直すと、新しい連番になる（過去の id と重ならない。完了条件 (g)）
      resetLimits();
      const again = a.uploadUke(me, bytesA).filter((u) => u.uploaded);
      expect(again.map((u) => u.receipts.map((x) => x.claimId))).toEqual([["U2-1"], ["U3-1", "U3-2"]]);
      expect(JSON.parse(a.setting("uke-uploads")!)).toMatchObject({ next: 4, files: [{ seq: 2 }, { seq: 3 }] });
      // 消えた患者の番号を取り直しても、いまある患者とぶつからない
      expect(a.patientFacts("U3-2").patientId).not.toBe(stays);
      expect(a.patientFacts("U3-1").patientId).toBe(stays);
    });

    // ベテランも消せる。残りのファイルを消すと、どちらのファイルにもいた患者も消える
    setRole("veteran");
    expect((await del(cookie, sha(bytesB))).status).toBe(200);
    expect((await del(cookie, sha(bytesA))).status).toBe(200);
    const empty = dump(dbFile);
    for (const id of ["U1-1", "U2-1", "U3-1", "U3-2", stays, goes]) expect([id, tablesWith(empty, id)]).toEqual([id, []]);
    expect(readdirSync(ukeDir)).toEqual([]);
    expect(queryFiles()).toEqual([]);
  });

  it("メンターの応答を待っている間にファイルを消すと、応答が戻っても痕跡（セッション・雑談の回数・ベテランへの問い・医師確認）が戻らない（S-8）", async () => {
    const owner = auth().register("erase_wait", "やまだ", "password123");
    const me = instance.clerkIdOf(owner);
    const bytes = readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE"));
    const base = readUke(bytes);
    const file = writeUke({ ...base, receipts: [{ ...base.receipts[0], claimId: "A1", patient: { ...base.receipts[0].patient, name: "架空 待機", insurer: { number: "06139991", symbol: "77", no: "601" } } }] });
    const dbFile = instance.tenantPaths(owner.tenantId).dbFile;
    const workspace = path.join(tmp, "ws", owner.tenantId, me);
    auth().switchRole(owner, "veteran");
    const cookie = cookieOf(owner);
    sdk.deleted.length = 0;

    const qid = await instance.runAs(owner, async () => {
      const a = instance.getApp();
      a.uploadUke(me, file);
      const q = a.start(me, "U1-1");
      // 1 回目の相談は最後まで終える（セッション s-test ができる）
      await instance.talkToMentor({ user: owner, clerkId: me, questionId: q.id, message: "ヒントをください", situation: "通常" });
      expect(a.clerk(me).session_id).toBe("s-test");
      return q.id;
    });

    // 2 回目の相談：応答を保留する。保留が解けたあと、メンターが自前のツール（ベテランへの問い・医師確認）を呼んでから返事をする
    let arrived!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((ok) => (arrived = ok));
    const gate = new Promise<void>((ok) => (release = ok));
    const toolErrors: string[] = [];
    sdk.hold = async (call) => {
      sdk.hold = null; // ベテランのメンターの呼び出しは保留しない
      arrived();
      await gate;
      const tools = ((call.options.mcpServers as Record<string, { instance: unknown }>).resemen.instance as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> })._registeredTools;
      const doctor = { field: "病型", why: "記載がない", question: "病型について、該当するものを選んでください。", indicators: [{ source: "カルテ", text: "AF" }], options: ["発作性", "持続性", "その他", "判定不能"] };
      for (const [name, args] of [["ask_peer_mentor", { question: "この加算の条件は？" }], ["ask_human", { question: "院内ではどうしていますか" }], ["ask_doctor", doctor]] as const) {
        try {
          const r = await tools[name].handler(args, {});
          if ((r as { isError?: boolean }).isError) toolErrors.push(name);
        } catch {
          toolErrors.push(name);
        }
      }
    };
    const talk = instance.runAs(owner, () => instance.talkToMentor({ user: owner, clerkId: me, questionId: qid, message: "もう少し教えてください", situation: "通常" }));
    const settled = talk.then(() => "ok", (e: Error & { status?: number }) => e.status);
    await waiting;

    // 待っている間に、ファイルを消す
    expect((await del(cookie, createHash("sha256").update(file).digest("hex"))).status).toBe(200);
    expect(sdk.deleted).toEqual([{ id: "s-test", dir: workspace }]);
    release();
    // 応答は戻るが、相談は 404 で終わり、何も書かれない
    expect(await settled).toBe(404);
    expect(toolErrors).toEqual(expect.arrayContaining(["ask_peer_mentor", "ask_human"]));

    const after = dump(dbFile);
    for (const id of ["U1-1", qid, "s-test"]) expect([id, tablesWith(after, id)]).toEqual([id, []]);
    expect(after.peer_questions).toBe("[]");
    expect(after.clerk_sessions).toBe("[]");
    expect(JSON.parse(after.app_settings).filter((r: { key: string }) => /^(smalltalk|vent):/.test(r.key))).toEqual([]);
    // 応答が運んできたセッションも消してある（消す操作の 1 回と、応答のあとの 1 回）
    expect(sdk.deleted.filter((d) => d.id === "s-test" && d.dir === workspace).length).toBeGreaterThanOrEqual(2);
    expect(readdirSync(instance.tenantPaths(owner.tenantId).queryLogDir)).toEqual([]);
    instance.runAs(owner, () => expect(instance.getApp().clerk(me).session_id).toBeNull());
  });
});
