// 届け出た酸素の単価の入出力（design.md §19-3・§19-10 完了条件 10。v44 段 22e）：追記だけ・取り消しは取り消しの行・入力の検査・AI と UKE の書き出しに入らない
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeOxygenPrices, centiOf, fiscalYearOf, oxygenPriceForDates, oxygenPriceOn, type OxygenPriceRow } from "../../src/facility/oxygen";
import { claimForAi } from "../../src/llm/outbound";
import type { App } from "../../src/server/app";
import { oxygenPriceBody } from "../../src/server/schemas/facility";
import { readUke, writeUke } from "../../src/uke/uke";
import { repo, tempApp } from "../helpers/care";

let app: App;
let close: () => void;
beforeEach(() => ({ app, close } = tempApp()));
afterEach(() => close());

const input = { kind: "small" as const, price: "1.87", validFrom: "2026-04-01", validUntil: "2027-03-31", basis: "前年の購入実績" as const };

describe("届け出た酸素の単価（段 22e）", () => {
  it("入れると今日に効く単価が出る。取り消しは取り消しの行を足すだけで、元の行は残る", () => {
    const first = app.saveOxygenPrice("new1", input);
    expect(first.rows).toHaveLength(1);
    expect(first.kinds.find((k) => k.kind === "small")!.todayCenti).toBe(187);
    const id = first.rows[0].id;
    const after = app.saveOxygenPrice("new1", { revokes: id });
    expect(after.rows).toEqual([]);
    expect(after.kinds.find((k) => k.kind === "small")!.todayCenti).toBeNull();
    // 取り消しの行は、取り消した行を指すだけ（同じ行は 2 回取り消せない）
    expect(() => app.saveOxygenPrice("new1", { revokes: id })).toThrow(/もう取り消して/);
  });

  it("入力の初期値は、今日（デモの時計）が属する年度の 4 月 1 日と翌年の 3 月 31 日", () => {
    const v = app.oxygenPrices();
    expect(v.defaults).toEqual(fiscalYearOf(v.today));
    expect(fiscalYearOf("2026-10-13")).toEqual({ validFrom: "2026-04-01", validUntil: "2027-03-31" });
    expect(fiscalYearOf("2027-02-01")).toEqual({ validFrom: "2026-04-01", validUntil: "2027-03-31" });
  });

  it("0.01 円より細かい単価・0 以下・始めが終わりより後の行は、入力で拒む", () => {
    expect(oxygenPriceBody.safeParse(input).success).toBe(true);
    expect(oxygenPriceBody.safeParse({ ...input, price: "0.305" }).success).toBe(false);
    expect(oxygenPriceBody.safeParse({ ...input, price: "0" }).success).toBe(false);
    expect(oxygenPriceBody.safeParse({ ...input, validFrom: "2027-04-01", validUntil: "2027-03-31" }).success).toBe(false);
    expect(oxygenPriceBody.safeParse({ ...input, kind: "nitrogen" }).success).toBe(false);
    expect(() => app.saveOxygenPrice("new1", { ...input, price: "0.305" })).toThrow();
    expect(centiOf("0.3")).toBe(30);
    expect(centiOf("2.36")).toBe(236);
  });

  it("効く単価：期間に入る行のうち後に入れた行。算定日で単価が分かれる・期間に入らない日がある単位は split", () => {
    const row = (id: number, priceCenti: number, validFrom: string, validUntil: string, revokes: number | null = null): OxygenPriceRow => ({ id, kind: "large", priceCenti, validFrom, validUntil, basis: "前年の購入実績", enteredBy: "x", enteredAt: "x", revokes });
    const rows = [row(1, 30, "2026-04-01", "2027-03-31"), row(2, 35, "2026-10-15", "2027-03-31"), row(3, 40, "2026-10-01", "2026-10-31"), row(4, 40, "2026-10-01", "2026-10-31", 3)];
    const active = activeOxygenPrices(rows);
    expect(active.map((r) => r.id)).toEqual([1, 2]);
    expect(oxygenPriceOn(active, "large", "2026-10-03")).toBe(30);
    expect(oxygenPriceOn(active, "large", "2026-10-20")).toBe(35);
    expect(oxygenPriceForDates(active, "large", ["2026-10-03", "2026-10-05"])).toEqual({ priceCenti: 30, split: false });
    expect(oxygenPriceForDates(active, "large", ["2026-10-03", "2026-10-20"])).toEqual({ priceCenti: null, split: true });
    expect(oxygenPriceForDates(active, "small", ["2026-10-03"])).toEqual({ priceCenti: null, split: false });
    expect(oxygenPriceForDates([row(5, 30, "2026-10-10", "2026-10-31")], "large", ["2026-10-03", "2026-10-20"])).toEqual({ priceCenti: null, split: true });
  });

  it("届け出た単価は、AI に送る文脈と UKE の書き出しに入らない", () => {
    app.saveOxygenPrice("new1", { ...input, price: "9.87" });
    const uke = readUke(readFileSync(path.join(repo, "fixtures", "uke", "jitsurei.UKE")));
    const written = new TextDecoder("shift_jis").decode(writeUke(uke));
    expect(written).not.toContain("9.87");
    const claimId = app.cases()[0].claimId;
    expect(JSON.stringify(claimForAi(app.caseOf(claimId)))).not.toContain("9.87");
    expect(JSON.stringify(claimForAi(app.caseOf(claimId)))).not.toContain("987");
  });
});
