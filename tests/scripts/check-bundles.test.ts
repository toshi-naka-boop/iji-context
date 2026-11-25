// 包括の群と告示の号の対応（design.md §19-2・§19-10 完了条件 2）。データは同梱しないので、RESEMEN_MASTER_DIR があるときだけ動く
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkBundles, GROUPS, membersOf } from "../../scripts/check-bundles";
import { resolveRevision } from "../../src/engine/revisions";
import { openMasters, pickSnapshot } from "../../src/masters/db";
import { YM } from "../helpers/period";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
const root = path.join(__dirname, "..", "..");

/** EM §2-8「G・H のコード」の項目の一覧（D008・D013） */
function emMembers(name: string): string[] {
  const em = readFileSync(path.join(root, "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8");
  const line = em.split("\n").find((l) => l.startsWith(`- ${name} `) && l.includes("の包括の項目"));
  if (!line) throw new Error(`EM §2-8 に ${name} の項目の一覧がない`);
  return line.slice(line.lastIndexOf("：") + 1).split("・");
}

describe("包括の群と告示の号の対応（段 22a）", () => {
  it.skipIf(!has)("EM の D008・D013 の一覧は、マスターの群と 1 対 1 で、区分番号・号の範囲も合う", () => {
    const db = openMasters(file)!;
    const snap = pickSnapshot(db, "shinryo", YM, resolveRevision(YM).generation)!.snapshot;
    const r = checkBundles(db, snap, GROUPS.map((group) => ({ group, members: emMembers(group.name) })));
    expect(r.lines.filter((l) => l.includes("NG"))).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it.skipIf(!has)("版の members を 1 つ消すか、範囲の外の号のコードを足すと、合わない", () => {
    const db = openMasters(file)!;
    const snap = pickSnapshot(db, "shinryo", YM, resolveRevision(YM).generation)!.snapshot;
    const d013 = GROUPS.find((g) => g.name === "D013")!;
    const members = emMembers("D013");
    expect(checkBundles(db, snap, [{ group: d013, members: members.slice(1) }]).ok).toBe(false);
    // ＴＳＨ（160031710）は D008 の号 6。D008 の範囲（12〜51）の外
    const d008 = GROUPS.find((g) => g.name === "D008")!;
    expect(checkBundles(db, snap, [{ group: d008, members: [...emMembers("D008"), "160031710"] }]).ok).toBe(false);
    expect(checkBundles(db, snap, [{ group: d008, members: null }]).ok).toBe(false);
  });

  it("版の bundles から、区分キーの頭で群の members を引く", () => {
    expect(membersOf([{ members: ["1"], tiers: [{ kubun: "D013_3" }] }], "D013_")).toEqual(["1"]);
    expect(membersOf([{ members: ["1"], tiers: [{ kubun: "D013_3" }] }], "D008_")).toBeNull();
  });
});
