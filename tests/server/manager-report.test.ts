// 事務長レポートの期間（採点 r2 事務長 #2）：確定した月で分ける。月を省けば全期間の累計
import { describe, expect, it } from "vitest";
import { checkDraft, confirm, startQuestion, type Question } from "../../src/practice/practice";
import { jstYearMonth } from "../../src/lifecycle/time";
import { createPrevented } from "../../src/server/app/prevented";
import type { Doctor } from "../../src/server/app/doctor";
import type { Questions } from "../../src/server/app/questions";
import type { ReviewReport } from "../../src/review/report";
import { loadCase, without } from "../engine/helpers";
import { at, dateIn } from "../helpers/period";

/** K2 で包括的支援加算と在宅移行早期加算の取り忘れを指摘され、足して確定した問題（取りこぼし 2 件・2,500 円） */
function fixedK2(id: string, when: string): Question {
  const k2 = loadCase("K2");
  let q = startQuestion(id, "c1", k2.claimId, when);
  q = checkDraft(q, without(k2, "C002_N10_HOKATSU", "C002_N4_IKOU"), when).question;
  return confirm(q, k2, when);
}

describe("事務長レポートの期間", () => {
  it("月を渡すとその月に確定した分だけ、省くと全期間の累計。確定した月の一覧は新しい順", () => {
    const thisMonth = at(12);
    const nextMonth = `${dateIn(1, 3)}T09:00:00+09:00`;
    const qs = [fixedK2("q1", thisMonth), fixedK2("q2", nextMonth)];
    const p = createPrevented({ submitted: () => qs } as unknown as Questions, { resolvedFields: () => [] } as unknown as Doctor, () => ({ runs: [], fingerprint: "x" }) as unknown as ReviewReport & { fingerprint: string });
    const [m1, m2] = [jstYearMonth(thisMonth), jstYearMonth(nextMonth)];
    const all = p.manager();
    expect([all.month, all.months, all.取りこぼし]).toEqual([null, [m2, m1], { count: 4, yen: 5000 }]);
    const one = p.manager(m1);
    expect([one.month, one.months, one.取りこぼし]).toEqual([m1, [m2, m1], { count: 2, yen: 2500 }]);
    expect(p.manager("2000-01").取りこぼし).toEqual({ count: 0, yen: 0 });
  });
});
