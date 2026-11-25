// 撮影部位のコメントの許可リストと、コメントマスターの突き合わせ（design.md §19-1・§19-10 完了条件 4）。RESEMEN_MASTER_DIR があるときだけ動く
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { r2026 } from "../../src/engine/revisions/r2026";
import { openMasters } from "../../src/masters/db";
import { readEm, verifyMasters } from "../../src/masters/verify";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
const root = path.join(__dirname, "..", "..");
const diffLines = (lines: string[]) => lines.filter((l) => l.startsWith("撮影部位のコメントの許可リストがマスターと違う"));

describe("撮影部位のコメントの許可リスト（段 22c）", () => {
  it.skipIf(!has)("版の許可リストがコメントマスターの「撮影部位（」の行と同じなら食い違いなし。1 つ消す・ほかのコードを足すと失敗", () => {
    const db = openMasters(file)!;
    const em = readEm(root);
    expect(diffLines(verifyMasters(db, em, { write: false, revisions: [r2026] }).lines)).toEqual([]);
    const fewer = { ...r2026, imagingSiteComments: r2026.imagingSiteComments.slice(1) };
    const r1 = verifyMasters(db, em, { write: false, revisions: [fewer] });
    expect(diffLines(r1.lines).length).toBeGreaterThan(0);
    expect(r1.failures).toBeGreaterThan(0);
    const more = { ...r2026, imagingSiteComments: [...r2026.imagingSiteComments, "842100072"] };
    expect(diffLines(verifyMasters(db, em, { write: false, revisions: [more] }).lines).length).toBeGreaterThan(0);
  });

  it.skipIf(!has)("check:masters は包括の群とマスターを突き合わせ、members を 1 つ消すと失敗にする（§19-12。C-621）", () => {
    const db = openMasters(file)!;
    const em = readEm(root);
    const groupLines = (l: string[]) => l.filter((x) => x.startsWith("包括の群がマスターと合わない"));
    expect(groupLines(verifyMasters(db, em, { write: false, revisions: [r2026] }).lines)).toEqual([]);
    const fewer = { ...r2026, bundles: r2026.bundles.map((b) => (b.tiers[0].kubun === "D008_3" ? { ...b, members: b.members.slice(1) } : b)) };
    const r = verifyMasters(db, em, { write: false, revisions: [fewer] });
    expect(groupLines(r.lines).length).toBeGreaterThan(0);
    expect(r.failures).toBeGreaterThan(0);
  });
});

describe("撮影部位はコードと記入値の組で数える（反証 round-95 X-480）", () => {
  it.skipIf(!has)("肩（830181200）の「右」と「左」が付いた単純撮影（ロ）の写真診断（170000510。数量 2）は、違う部位が 2 つなので対象外（imagingSites）。同じ記入値が 2 つなら対象外にしない", async () => {
    const { recalcClaim } = await import("../../src/generic/g02");
    const db = openMasters(file)!;
    const unit = { points: 1, count: 1, days: Array.from({ length: 31 }, (_, d) => (d === 9 ? 1 : 0)), items: [{ kind: "SI" as const, code: "170000510", line: 10, shikibetsu: "70", quantity: "2" }] };
    const claim = (raws: string[]) => ({ units: [unit], comments: raws.map((raw, i) => ({ line: 11 + i, code: "830181200", raw, unit: null })) });
    const about = { yearMonth: "2026-10", generation: r2026.generation };
    expect(recalcClaim(claim(["右", "左"]), db, about)).toMatchObject([{ status: "excluded", reason: "imagingSites" }]);
    const same = recalcClaim(claim(["右", "右"]), db, about) as { status: string; reason?: string }[];
    expect(same[0].reason).not.toBe("imagingSites");
  });
});
