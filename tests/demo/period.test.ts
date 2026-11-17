// design.md §7 #17：デモの日付（config/demo.json）。種の日付は直近の改定日より後・時計の初期値より前で、種を入れた直後に制度層が要再検証にならない
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimIdOf, dateFrom, dayOf, mdOf, monthFrom, period } from "../../src/demo/period";
import { hasRevision } from "../../src/engine/revisions";
import { latestRevision, type Calendar } from "../../src/lifecycle/calendar";
import { listKnowledge } from "../../src/lifecycle/store";
import { evaluateTriggers } from "../../src/lifecycle/triggers";
import type { BusinessDays } from "../../src/query/doctor-query";
import { seed, SEED_AT } from "../../scripts/seed-knowledge";

const root = path.join(__dirname, "..", "..");
const json = <T>(f: string) => JSON.parse(readFileSync(path.join(root, "config", f), "utf8")) as T;
const calendar = json<Calendar>("calendar.json");
const businessDays = json<BusinessDays>("business-days.json");
const t = (s: string) => Date.parse(s);

describe("デモの日付", () => {
  it("基準月には改定の版があり、請求月は基準月の翌月。時計の初期値は基準月の中", () => {
    expect(hasRevision(period.yearMonth)).toBe(true);
    expect(period.billingMonth).toBe(monthFrom(1));
    expect(period.clockStart.startsWith(period.yearMonth)).toBe(true);
  });
  it("直近の改定日 ≤ 種の日付 ≤ 時計の初期値", () => {
    expect(SEED_AT).toBe(period.seedAt);
    expect(t(latestRevision(calendar, period.clockStart))).toBeLessThanOrEqual(t(period.seedAt));
    expect(t(period.seedAt)).toBeLessThanOrEqual(t(period.clockStart));
  });
  it("種を入れた直後の整理では、制度層の知識が 1 件も発火しない", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "iji-period-"));
    const store = { knowledgeDir: path.join(dir, "knowledge"), skillsDir: path.join(dir, "skills") };
    expect(seed(store).length).toBeGreaterThan(0);
    const metas = listKnowledge(store);
    expect(metas.every((m) => m.layer === "制度" && m.status === "承認済み")).toBe(true);
    expect(evaluateTriggers(metas, period.clockStart, calendar)).toEqual([]);
  });
  it("時計の初期値は休診日でない（祝日でも土日でもない）", () => {
    const date = period.clockStart.slice(0, 10);
    expect(businessDays.holidays).not.toContain(date);
    expect(businessDays.closedWeekdays).not.toContain(new Date(`${date}T00:00:00Z`).getUTCDay());
    // 基準月の祝日（スポーツの日）が休診日に入っている
    expect(businessDays.holidays.some((d) => d.startsWith(period.yearMonth))).toBe(true);
  });
  it("日付の組み立て：基準月の日・画面の表記・請求 id・前後の月", () => {
    expect(dayOf(5)).toBe(`${period.yearMonth}-05`);
    expect(mdOf(5)).toBe(`${Number(period.yearMonth.slice(5))}/5`);
    expect(claimIdOf("K1")).toBe(`K1-${period.yearMonth}`);
    expect(monthFrom(0)).toBe(period.yearMonth);
    expect(monthFrom(-12)).toBe(`${Number(period.yearMonth.slice(0, 4)) - 1}${period.yearMonth.slice(4)}`);
    expect(dateFrom(0, 9)).toBe(dayOf(9));
    // 年をまたぐ
    const [y, m] = period.yearMonth.split("-").map(Number);
    expect(monthFrom(13 - m)).toBe(`${y + 1}-01`);
    expect(monthFrom(-m)).toBe(`${y - 1}-12`);
  });
});
