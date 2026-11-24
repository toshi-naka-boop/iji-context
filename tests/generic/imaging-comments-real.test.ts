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
});
