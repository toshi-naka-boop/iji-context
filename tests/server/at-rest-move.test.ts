// 今ある平文のデータを移す（spec FR-217）と、鍵の入れ替え（FR-218）。平文の見本の置き場を作って流す。鍵はその場で作る
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DataKeyError } from "../../src/db/key";
import { openDatabase, type Db } from "../../src/db/open";
import { readSealed } from "../../src/db/sealed";
import { sqliteSessionStore } from "../../src/llm/session-store";
import { createQuery, listQueries } from "../../src/query/doctor-query";
import { openApp } from "../../src/server/app";
import { assertAtRest, atRestTargets } from "../../src/server/at-rest";
import { backupData, encryptAll, planMove, rotateAll, type TranscriptSink } from "../../src/server/at-rest-move";
import { openAuth } from "../../src/server/auth";
import type { UkeFile } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";

const repo = path.join(__dirname, "..", "..");
const TENANT = "t0123456789ab";
const MARK = "目印移子丙";
const SID = "11111111-2222-4333-8444-555555555555";
let tmp: string;
let data: string;
const key1 = randomBytes(32);
const key2 = randomBytes(32);

/** 置き場の全部のファイルの中身のハッシュ（何も変えていないことの確かめ） */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = path.join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else out[path.relative(dir, f)] = createHash("sha256").update(readFileSync(f)).digest("hex");
    }
  };
  walk(dir);
  return out;
}
const counts = (db: Db) =>
  Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => [t.name, (db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n: number }).n]));
const tenantDb = () => path.join(data, "tenants", TENANT, "app.db");
const sink =
  (key: Buffer): TranscriptSink =>
  (tenant) => {
    const db = openDatabase(path.join(data, "tenants", tenant, "app.db"), `app:${tenant}`, {}, key);
    const s = sqliteSessionStore(db);
    return { append: (k, e) => s.append(k, e), load: (k) => s.load(k), close: () => db.close() };
  };
let before: { auth: Record<string, number>; app: Record<string, number> };

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  tmp = mkdtempSync(path.join(tmpdir(), "iji-move-"));
  data = path.join(tmp, "data");
  // 平文の見本：auth.db（WAL）・クリニックの app.db・取り込んだ UKE・医師確認の記録・前の版の会話の記録
  const auth = openAuth(path.join(data, "auth.db"));
  auth.register("move_owner", "やまだ", "password123");
  auth.close();
  const dir = path.join(data, "tenants", TENANT);
  mkdirSync(dir, { recursive: true });
  const a = openApp({ root: repo, dbFile: path.join(dir, "app.db"), knowledgeDir: path.join(dir, "knowledge"), skillsDir: path.join(dir, "skills"), queryLogDir: path.join(dir, "query-log") });
  a.upsertClerk({ id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" });
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "kokuhoren.UKE")));
  const file: UkeFile = { ...base, receipts: [{ ...base.receipts[0], claimId: "MKMV1", patient: { ...base.receipts[0].patient, name: MARK } }] };
  a.uploadUke("new1", writeUke(file));
  createQuery(a.queryLog, { claimId: "K2", field: "病型", why: "記載がない", question: "病型について、該当するものを選んでください。", indicators: [{ source: "カルテ", text: MARK }], options: ["発作性", "持続性", "その他", "判定不能"], createdBy: "clerk" }, "2026-10-10T09:00:00+09:00");
  a.close();
  const project = path.join(data, "home", ".claude", "projects", `-data-workspaces-${TENANT}-new1`);
  mkdirSync(path.join(project, SID, "subagents"), { recursive: true });
  writeFileSync(path.join(project, `${SID}.jsonl`), [{ type: "user", uuid: "u1", message: { content: MARK } }, { type: "assistant", uuid: "a1", message: { content: "x" } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(path.join(project, SID, "subagents", "agent-1.jsonl"), `${JSON.stringify({ type: "user", uuid: "s1" })}\n`);
  const read = (f: string, p: "auth" | `app:${string}`) => {
    const db = openDatabase(f, p, { readonly: true }, null);
    const c = counts(db);
    db.close();
    return c;
  };
  before = { auth: read(path.join(data, "auth.db"), "auth"), app: read(tenantDb(), `app:${TENANT}`) };
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("今ある平文のデータを移す", () => {
  it("--dry-run（対象の一覧）では何も変わらない。対象はデータベース・UKE・医師確認の記録・会話の記録", () => {
    const snap = snapshot(data);
    const plan = planMove(atRestTargets(data, tmp), data);
    expect(plan.dbs.map((d) => [path.relative(data, d.file), d.state])).toEqual([["auth.db", "plain"], [`tenants/${TENANT}/app.db`, "plain"]]);
    expect(plan.files.map((f) => f.state)).toEqual(["plain", "plain", "plain"]);
    expect(plan.transcripts.map((t) => t.tenant)).toEqual([TENANT, TENANT]);
    expect(snapshot(data)).toEqual(snap);
    // 鍵があっても、移すまでは起動しない
    expect(() => assertAtRest({ RESEMEN_DATA_KEY: key1.toString("hex") }, { data, root: tmp })).toThrow(DataKeyError);
  });

  it("控えを取ってから移すと、表ごとの行数とスキーマの版が元と同じで、鍵つきの起動が通る。目印はどのファイルにも出ない", async () => {
    const backup = backupData(data, path.join(tmp, "backup"));
    expect(snapshot(backup)).toEqual(snapshot(data));
    expect(() => backupData(data, path.join(data, "inside"))).toThrow(/外/);
    const r = await encryptAll(data, tmp, key1, sink(key1));
    expect(r.dbs.map((d) => d.done)).toEqual(["encrypted", "encrypted"]);
    expect(r.dbs[0].summary.counts).toEqual(before.auth);
    // 会話の記録は app.db に写る（行が 3 つ増える）。それ以外の表の行数は元と同じ
    const app = openDatabase(tenantDb(), `app:${TENANT}`, { readonly: true }, key1);
    expect(counts(app)).toEqual({ ...before.app, sdk_transcripts: before.app.sdk_transcripts + 3 });
    app.close();
    expect(r.files.map((f) => f.done)).toEqual(["sealed", "sealed", "sealed"]);
    expect(r.transcripts.map((t) => t.entries)).toEqual([2, 1]);
    expect(assertAtRest({ RESEMEN_DATA_KEY: key1.toString("hex") }, { data, root: tmp })).toEqual({ encrypted: true });
    // 会話の記録は読み戻せる。元の JSONL は消えている
    const s = sink(key1)(TENANT);
    expect(await s.load({ projectKey: "", sessionId: SID })).toEqual([{ type: "user", uuid: "u1", message: { content: MARK } }, { type: "assistant", uuid: "a1", message: { content: "x" } }]);
    s.close();
    expect(atRestTargets(data, tmp).transcripts).toEqual([]);
    // 医師確認の記録・UKE は鍵で読める
    vi.stubEnv("RESEMEN_DATA_KEY", key1.toString("hex"));
    try {
      expect(listQueries({ dir: path.join(data, "tenants", TENANT, "query-log") }).map((q) => q.indicators[0].text)).toEqual([MARK]);
    } finally {
      vi.unstubAllEnvs();
    }
    const files = Object.keys(snapshot(data)).map((f) => path.join(data, f));
    expect(files.filter((f) => readFileSync(f).includes(Buffer.from(MARK)))).toEqual([]);
    expect(files.filter((f) => readFileSync(f).subarray(0, 15).toString("latin1") === "SQLite format 3")).toEqual([]);
  });

  it("二度流しても結果が同じ（済んだものは開けることだけ確かめ、何も書き換えない）", async () => {
    const snap = snapshot(data);
    const r = await encryptAll(data, tmp, key1, sink(key1));
    expect(r.dbs.map((d) => d.done)).toEqual(["already", "already"]);
    expect(r.files.map((f) => f.done)).toEqual(["already", "already", "already"]);
    expect(snapshot(data)).toEqual(snap);
    // 違う鍵で流すと、開けないので止まる（何も変えない）
    await expect(encryptAll(data, tmp, key2, sink(key2))).rejects.toThrow(DataKeyError);
    expect(snapshot(data)).toEqual(snap);
  });
});

describe("鍵の入れ替え", () => {
  it("入れ替えたあと、新しい鍵で全部開け、古い鍵では開けない", () => {
    rotateAll(data, tmp, key1, key2);
    for (const [f, p] of [[path.join(data, "auth.db"), "auth"], [tenantDb(), `app:${TENANT}`]] as const) {
      const db = openDatabase(f, p, { readonly: true }, key2);
      db.close();
      expect(() => openDatabase(f, p, { readonly: true }, key1)).toThrow(DataKeyError);
    }
    const q = readdirSync(path.join(data, "tenants", TENANT, "query-log")).map((n) => path.join(data, "tenants", TENANT, "query-log", n));
    for (const f of q) {
      expect(readSealed(f, key2).length).toBeGreaterThan(0);
      expect(() => readSealed(f, key1)).toThrow(DataKeyError);
    }
    expect(assertAtRest({ RESEMEN_DATA_KEY: key2.toString("hex") }, { data, root: tmp })).toEqual({ encrypted: true });
    expect(() => assertAtRest({ RESEMEN_DATA_KEY: key1.toString("hex") }, { data, root: tmp })).toThrow(DataKeyError);
    // 入れ替えたあとも、行数は変わらない
    const app = openDatabase(tenantDb(), `app:${TENANT}`, { readonly: true }, key2);
    expect(counts(app).sdk_transcripts).toBe(before.app.sdk_transcripts + 3);
    app.close();
  });

  it("同じ鍵・平文の残りがあるときは入れ替えない", () => {
    expect(() => rotateAll(data, tmp, key2, key2)).toThrow(/同じ/);
    writeFileSync(path.join(data, "tenants", TENANT, "query-log", "plain.md"), "x");
    expect(() => rotateAll(data, tmp, key2, randomBytes(32))).toThrow(/encrypt-at-rest/);
    rmSync(path.join(data, "tenants", TENANT, "query-log", "plain.md"));
  });
});
