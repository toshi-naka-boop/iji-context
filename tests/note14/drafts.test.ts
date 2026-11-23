// 段 17k：注14 の計算の道具の 2 段目の下書き（design.md §15-13）。①②③⑤ の自動入力、患者の数え方（X-173・X-180・C-341）、未入力 n 人、出どころの印
import { describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import { draftOf, type DraftReceipt } from "../../src/note14/drafts";
import { evaluate, monthsBefore, periodOf, shiftMonth, toolConstsOf, type Stage1Input } from "../../src/note14/evaluate";
import { fieldKeys } from "../../src/note14/readings";
import { month } from "../helpers/period";
import { receipt } from "./uke";

const M = month(1);
const K = toolConstsOf(resolveRevision(M).consts.note14)!;
const P = periodOf(M, K);
const [m1, m2, m3] = monthsBefore(M, K.periodMonths.short);
const person = (name: string, birth: string, receiptType?: string) => receipt(m1, [], { name, birth, receiptType }).patient;
const A = person("架空 甲子", "19400101");
const B = person("架空 乙子", "19410202");
const r = (yearMonth: string, patient: DraftReceipt["patient"], families: DraftReceipt["families"], excluded = false): DraftReceipt => ({ yearMonth, patient, families, excluded });
const all = (v: Record<string, number>, id: string) => Object.fromEntries(Object.entries(v).filter(([k]) => k.split(":")[0] === id));

describe("2 段目の下書き（純関数）", () => {
  it("X-173：患者 A が 1 か月だけ在医総管、患者 B が 3 か月とも施医総管 → ①② の実人数は 1 と 1、延べは 1 と 3（A・B は診療年月を外した鍵で 1 人ずつ）。R8-199 が実人数と延べで割れる", () => {
    const d = draftOf([r(m2, A, ["在医総管"]), r(m1, B, ["施設総管"]), r(m2, B, ["施設総管"]), r(m3, B, ["施設総管"])], [m1, m2, m3], () => true);
    expect(d.ok && { ...all(d.values, "c002"), ...all(d.values, "c0022") }).toEqual({ "c002:U-33a=A": 1, "c002:U-33a=B": 1, "c0022:U-33a=A": 1, "c0022:U-33a=B": 3 });
    const stage1: Stage1Input = { months: [m1, m2, m3].map((month, i) => ({ month, kou: i === 0 ? K.visitThreshold : 0, otsuExtra: 0, source: "auto" })), gansou: 0, secondPatient: 0, special: "none", institutions: [] };
    const values: Record<string, number | null> = Object.fromEntries(fieldKeys().map((f) => [f.key, f.field.id === "referral" ? K.referralMin : f.field.id === "mitoriHome" ? K.mitoriMin : 0]));
    const e = evaluate({ stage1, stage2: { values: { ...values, ...(d.ok ? d.values : {}) } } }, K, P);
    expect(e.status === "done" && [e.result, e.splits]).toEqual(["undecided", ["U-33a"]]);
  });
  it("X-180：A が 1 か月だけ在医総管を種別の違う 2 枚で請求しても、延べは 1（種別を外した鍵＋診療年月）。実人数も 1", () => {
    const A2 = person("架空 甲子", "19400101", "1318");
    const d = draftOf([r(m2, A, ["在医総管"]), r(m2, A2, ["在医総管"]), r(m1, B, ["施設総管"]), r(m2, B, ["施設総管"]), r(m3, B, ["施設総管"])], [m1, m2, m3], () => true);
    expect(d.ok && all(d.values, "c002")).toEqual({ "c002:U-33a=A": 1, "c002:U-33a=B": 1 });
  });
  it("C-341：同じ月のレセプトの鍵（種別を含む）が 2 枚で同じ月があると、自動で数えない（手入力に案内）。取り込みのない月も作らない", () => {
    const d = draftOf([r(m1, A, ["在医総管"]), r(m1, A, ["在医総管"]), r(m2, B, ["施設総管"]), r(m3, B, ["施設総管"])], [m1, m2, m3], () => true);
    expect(d).toEqual({ ok: false, reason: `${m1} は同じ月のレセプトが重なっているので、2 段目の下書きを作りません。数を入れてください` });
    expect(draftOf([r(m1, A, ["在医総管"])], [m1, m2, m3], () => true).ok).toBe(false);
  });
  it("③：除く患者は、版のターミナルケア加算・看取り加算・死亡診断加算の行がある患者だけ。1 回でも（甲）と算定した月の分だけ（乙）", () => {
    // B は m1 にだけ看取りの行（除く）。最後に算定した月（m3）には当たらない
    const d = draftOf([r(m1, B, ["施設総管"], true), r(m2, B, ["施設総管"]), r(m3, B, ["施設総管"]), r(m1, A, ["施設総管"]), r(m2, A, ["施設総管"]), r(m3, A, ["施設総管"])], [m1, m2, m3], () => true);
    expect(d.ok && all(d.values, "excluded")).toEqual({ "excluded:U-33a=A:U-33b=A": 1, "excluded:U-33a=A:U-33b=B": 0, "excluded:U-33a=B:U-33b=A": 3, "excluded:U-33a=B:U-33b=B": 1 });
  });
  it("⑤：要介護 3 以上・別表第八の二が事実にある患者だけを数え、事実のない患者は「未入力 n 人」に出して数に入れない", () => {
    const d = draftOf([r(m1, A, ["在医総管"]), r(m2, A, ["在医総管"]), r(m3, A, ["在医総管"]), r(m1, B, ["施設総管"]), r(m2, B, ["施設総管"]), r(m3, B, ["施設総管"])], [m1, m2, m3], (p) => (p.name === A.name ? true : null));
    expect(d.ok && [all(d.values, "care"), d.unknownCare]).toEqual([{ "care:U-33a=A:U-33c=A": 1, "care:U-33a=A:U-33c=B": 1, "care:U-33a=B:U-33c=A": 3, "care:U-33a=B:U-33c=B": 3 }, 1]);
  });
  it("下書きに鍵・患者の情報が現れない（数だけ）", () => {
    const d = draftOf([r(m1, A, ["在医総管"]), r(m2, A, ["在医総管"]), r(m3, B, ["施設総管"])], [m1, m2, m3], () => null);
    const s = JSON.stringify(d);
    for (const v of [A.name, A.name.replace(/\s/g, ""), A.birth, B.birth, A.insurer.no]) expect(s.includes(v), v).toBe(false);
    expect(shiftMonth(m3, 1)).toBe(M);
  });
});
