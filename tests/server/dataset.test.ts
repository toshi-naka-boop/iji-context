// design.md §7 #23：データの版の印（§10 段 2）。印が違う置き場を開いても、作り直しも退避も起きず、警告が記録される。
// 退避の操作は置き場を改名して残し（消さない）、作り直した置き場に今の印が付く
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seed } from "../../scripts/seed-knowledge";
import { period } from "../../src/demo/period";
import { listKnowledge } from "../../src/lifecycle/store";
import { openApp, type AppPaths } from "../../src/server/app";
import { DATASET_MISMATCH, readStamp, retireDir, staleTenants } from "../../src/server/dataset";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
/** クリニック（tenant）の置き場と同じ形：1 つのフォルダに DB・知識・Skill・医師確認の記録 */
const tenantDir = (id: string) => path.join(tmp, "tenants", id);
const pathsOf = (dir: string): AppPaths => ({ root: repo, dbFile: path.join(dir, "app.db"), knowledgeDir: path.join(dir, "knowledge"), skillsDir: path.join(dir, "skills"), queryLogDir: path.join(dir, "query-log") });
/** 置き場を作って閉じる */
function create(dir: string) {
  mkdirSync(dir, { recursive: true });
  const app = openApp(pathsOf(dir));
  seed(app.store);
  app.upsertClerk({ id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" });
  app.close();
}
/** 置き場の印を書き換える（古いデータの置き場に見立てる）。null は印なし */
function stamp(dir: string, value: string | null) {
  const db = new Database(path.join(dir, "app.db"));
  if (value === null) db.prepare("DELETE FROM app_settings WHERE key = 'dataset'").run();
  else db.prepare("UPDATE app_settings SET value = ? WHERE key = 'dataset'").run(value);
  db.close();
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-dataset-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("データの版の印", () => {
  const A = "t0123456789ab";
  it("新しく作った置き場には、今の印（config/demo.json の dataset）が付く。開き直しても警告は出ない", () => {
    create(tenantDir(A));
    expect(readStamp(path.join(tenantDir(A), "app.db"))).toBe(period.dataset);
    const app = openApp(pathsOf(tenantDir(A)));
    expect(app.dataset).toEqual({ stamp: period.dataset, current: period.dataset, ok: true });
    expect(app.audit.list().filter((r) => r.action === DATASET_MISMATCH)).toEqual([]);
    app.close();
  });

  it.each([["古い印", "r6-old"], ["印なし", null]])("%s の置き場を開いても、作り直しも退避も起きず、警告が 1 回だけ記録される", (_name, old) => {
    const dir = tenantDir(A);
    create(dir);
    stamp(dir, old);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = readdirSync(path.dirname(dir));
    const app = openApp(pathsOf(dir));
    // 止めずに開き、データはそのまま（利用者も知識も残っている。印も書き換えない）
    expect(app.dataset).toEqual({ stamp: old, current: period.dataset, ok: false });
    expect(app.clerk("new1").name).toBe("新人");
    expect(listKnowledge(app.store).length).toBeGreaterThan(0);
    expect(readdirSync(path.dirname(dir))).toEqual(before);
    const rows = app.audit.list().filter((r) => r.action === DATASET_MISMATCH);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "system", result: "error" });
    expect(rows[0].target).toContain(period.dataset);
    expect(warn).toHaveBeenCalledOnce();
    app.close();
    expect(readStamp(path.join(dir, "app.db"))).toBe(old);
    // もう一度開いても、同じ警告は増えない
    const again = openApp(pathsOf(dir));
    expect(again.audit.list().filter((r) => r.action === DATASET_MISMATCH)).toHaveLength(1);
    again.close();
  });

  it("印が違う置き場の一覧は、開かずに出せる。今の印の置き場は入らない", () => {
    const B = "tfedcba987654";
    create(tenantDir(A));
    create(tenantDir(B));
    stamp(tenantDir(B), "r6-old");
    expect(staleTenants(path.join(tmp, "tenants"))).toEqual([{ dir: tenantDir(B), stamp: "r6-old" }]);
    expect(staleTenants(path.join(tmp, "none"))).toEqual([]);
  });

  it("退避は置き場を改名して残す（消さない）。同じ場所に作り直した置き場には、今の印が付く", () => {
    const dir = tenantDir(A);
    create(dir);
    stamp(dir, "r6-old");
    const to = retireDir(dir, new Date("2030-01-02T03:04:05Z"));
    expect(to).toBe(`${dir}.retired-20300102T030405`);
    expect(existsSync(dir)).toBe(false);
    expect(readStamp(path.join(to, "app.db"))).toBe("r6-old");
    expect(existsSync(path.join(to, "knowledge"))).toBe(true);
    create(dir);
    expect(readStamp(path.join(dir, "app.db"))).toBe(period.dataset);
    expect(staleTenants(path.join(tmp, "tenants"))).toEqual([]);
    // 同じ時刻にもう一度退避しても、前の退避先を上書きしない
    expect(retireDir(dir, new Date("2030-01-02T03:04:05Z"))).toBe(`${dir}.retired-20300102T030405-2`);
    expect(existsSync(to)).toBe(true);
  });
});
