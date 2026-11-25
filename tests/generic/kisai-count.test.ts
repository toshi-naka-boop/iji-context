// 件数のスクリプト（scripts/count-kisai.ts）の数え方（src/generic/kisai-count.ts）：画面の上限で切られた指摘ではなく、全部を数える（X-323）
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGeneric } from "../../src/generic";
import { countKisai } from "../../src/generic/kisai-count";
import { FINDING_LIMIT } from "../../src/generic/types";
import { parseUke } from "../../src/uke/uke";
import { aboutOf, commentMasters } from "./small-comments";

describe("countKisai", () => {
  it("形の誤りが FINDING_LIMIT を超えても、全部を数える", () => {
    const parsed = parseUke(readFileSync(path.join(__dirname, "..", "..", "fixtures", "uke", "kokuhoren.UKE")));
    const claim = parsed.claims[0];
    const n = FINDING_LIMIT + 1;
    for (let i = 0; i < n; i++) claim.comments.push({ line: 100000 + i, code: "851100038", raw: "2460", unit: null });
    const one = { ...parsed, claims: [claim] };
    const db = commentMasters();
    // 画面の経路は上限で切る（数は omitted に出る）
    expect(evaluateGeneric(claim, db, aboutOf(claim)).findings.filter((f) => f.messageKey === "G07.form")).toHaveLength(FINDING_LIMIT);
    expect(countKisai([one], db).form).toBe(n);
  });
});
