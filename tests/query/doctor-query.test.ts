// F1 医師確認（spec FR-30〜37、impl-plan 11/6 の完了条件の決定的な部分）
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import businessDays from "../../config/business-days.json";
import {
  answerQuery,
  approveQuery,
  askMissing,
  businessDaysElapsed,
  createQuery,
  readQuery,
  tickQueries,
  validateQuery,
  type BusinessDays,
  type QueryDraft,
} from "../../src/query/doctor-query";

const cal = businessDays as BusinessDays;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "iji-query-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const log = () => ({ dir });

/** K4：カルテに「AF」のみ。DOAC 処方あり。病型を医師に確かめる */
const k4: QueryDraft = {
  claimId: "K4-2025-03",
  field: "SY:心房細動の病型",
  why: "カルテの病名が「AF」のみで、病型が書かれていない",
  question: "心房細動の病型について、診療録に記載がありません。該当するものを選んでください。",
  indicators: [
    { source: "カルテ 2025-03-11（S/A）", text: "AF。DOAC 継続" },
    { source: "処方 2025-03-11", text: "DOAC" },
  ],
  options: ["非弁膜症性心房細動", "弁膜症性心房細動", "その他", "判定不能"],
  createdBy: "mentor",
};
const T = (d: string) => `${d}T09:00:00+09:00`;

describe("K4 を流す（ask_missing → 医師確認 → 回答 → 承認）", () => {
  it("医師確認が 1 件でき、選択肢に「その他」「判定不能」があり、承認で SY が確定し、query-log/ に md と json が 1 組できる", () => {
    const r = askMissing(log(), { target: "doctor", ...k4 }, T("2025-03-11"));
    expect(r.route).toBe("F1");
    const q = r.route === "F1" ? r.query : (() => { throw new Error(); })();
    expect(q.options).toEqual(expect.arrayContaining(["その他", "判定不能"]));
    expect(readdirSync(dir).sort()).toEqual([`${q.id}.json`, `${q.id}.md`]);
    answerQuery(log(), q.id, { option: "非弁膜症性心房細動", answeredBy: "院長" }, T("2025-03-12"));
    const { query, confirmed } = approveQuery(log(), q.id, "院長", T("2025-03-12"));
    expect(confirmed).toEqual({ claimId: "K4-2025-03", queryId: q.id, name: "非弁膜症性心房細動", approver: "院長", at: T("2025-03-12") });
    expect(query.approval).toEqual({ approver: "院長", at: T("2025-03-12") });
    const md = readFileSync(path.join(dir, `${q.id}.md`), "utf8");
    expect(md).toContain("承認: 院長 / 2025-03-12T09:00:00+09:00");
    expect(md).toContain("- [x] 非弁膜症性心房細動");
    expect(readQuery(log(), q.id).status).toBe("承認済み");
  });

  it("回答だけでは SY は確定しない（承認が必要）。承認前に承認者名が空なら例外", () => {
    const q = createQuery(log(), k4, T("2025-03-11"));
    expect(() => approveQuery(log(), q.id, "院長", T("2025-03-11"))).toThrow(/承認できない/);
    answerQuery(log(), q.id, { option: "弁膜症性心房細動", answeredBy: "院長" }, T("2025-03-12"));
    expect(() => approveQuery(log(), q.id, " ", T("2025-03-12"))).toThrow(/承認者名/);
  });

  it("「判定不能」では SY は確定しない。「その他」は自由記述が必要で、その記述で確定する", () => {
    const a = createQuery(log(), k4, T("2025-03-11"));
    answerQuery(log(), a.id, { option: "判定不能", answeredBy: "院長" }, T("2025-03-12"));
    expect(approveQuery(log(), a.id, "院長", T("2025-03-12")).confirmed).toBeNull();
    const b = createQuery(log(), { ...k4, field: "SY:別件" }, T("2025-03-11"));
    expect(() => answerQuery(log(), b.id, { option: "その他", answeredBy: "院長" }, T("2025-03-12"))).toThrow(/自由記述/);
    answerQuery(log(), b.id, { option: "その他", freeText: "発作性心房細動", answeredBy: "院長" }, T("2025-03-12"));
    expect(approveQuery(log(), b.id, "院長", T("2025-03-12")).confirmed?.name).toBe("発作性心房細動");
  });

  it("医療事務あての ask_missing は F3 に回り、医師確認は作らない", () => {
    const r = askMissing(log(), { target: "clerk", claimId: "K3-2025-03", field: "受給者証の公費番号", why: "受給者証の写しがない" }, T("2025-03-11"));
    expect(r.route).toBe("F3");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});

describe("7 要件の検証（AI が作った質問も同じ基準。⑤）", () => {
  it("K4 の質問は通る", () => expect(validateQuery(k4)).toEqual([]));
  it("①臨床指標の引用がないと落ちる", () => expect(validateQuery({ ...k4, indicators: [] }).join()).toMatch(/①/));
  it("②誘導する言い回し・臨床的な選択肢が 1 つだけだと落ちる", () => {
    expect(validateQuery({ ...k4, question: "非弁膜症性心房細動ではないでしょうか。" }).join()).toMatch(/②誘導/);
    expect(validateQuery({ ...k4, options: ["非弁膜症性心房細動", "その他", "判定不能"] }).join()).toMatch(/②臨床的な選択肢/);
  });
  it("③「その他」「判定不能」がないと落ちる", () => {
    expect(validateQuery({ ...k4, options: ["非弁膜症性心房細動", "弁膜症性心房細動", "その他"] }).join()).toMatch(/③/);
  });
  it("④点数・金額・請求に触れると落ちる（質問・選択肢・引用のどこでも）", () => {
    expect(validateQuery({ ...k4, question: "算定のために病型を選んでください。" }).join()).toMatch(/④/);
    expect(validateQuery({ ...k4, options: ["非弁膜症性（4,585点）", "弁膜症性心房細動", "その他", "判定不能"] }).join()).toMatch(/④/);
    expect(validateQuery({ ...k4, indicators: [{ source: "メモ", text: "査定を避けたい" }] }).join()).toMatch(/④/);
  });
  it("検証に落ちた質問は作られず、query-log/ にも残らない", () => {
    expect(() => createQuery(log(), { ...k4, options: ["A", "B"] }, T("2025-03-11"))).toThrow(/要件を満たさない/);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});

describe("⑦ 未回答：翌営業日にリマインド、3 営業日で保留（FR-34）", () => {
  it("営業日は土日と祝日（3/20 春分の日）を除いて数える", () => {
    expect(businessDaysElapsed(T("2025-03-18"), T("2025-03-19"), cal)).toBe(1);
    expect(businessDaysElapsed(T("2025-03-18"), T("2025-03-21"), cal)).toBe(2); // 3/20 は祝日
    expect(businessDaysElapsed(T("2025-03-18"), T("2025-03-24"), cal)).toBe(3); // 3/22・23 は土日
    expect(businessDaysElapsed(T("2025-03-18"), "2025-03-23T23:59:00+09:00", cal)).toBe(2);
  });

  it("翌営業日にリマインド 1 回、3 営業日で保留。何度回しても同じ。保留の後に回答が来れば受け付ける", () => {
    const q = createQuery(log(), k4, T("2025-03-18"));
    expect(tickQueries(log(), T("2025-03-18"), cal)).toEqual({ reminded: [], held: [] });
    expect(tickQueries(log(), T("2025-03-19"), cal)).toEqual({ reminded: [q.id], held: [] });
    expect(tickQueries(log(), T("2025-03-21"), cal)).toEqual({ reminded: [], held: [] });
    expect(tickQueries(log(), T("2025-03-24"), cal)).toEqual({ reminded: [], held: [q.id] });
    expect(tickQueries(log(), T("2025-03-25"), cal)).toEqual({ reminded: [], held: [] });
    expect(readQuery(log(), q.id)).toMatchObject({ status: "保留", remindedAt: T("2025-03-19"), heldAt: T("2025-03-24") });
    answerQuery(log(), q.id, { option: "非弁膜症性心房細動", answeredBy: "院長" }, T("2025-03-25"));
    expect(readQuery(log(), q.id).status).toBe("回答済み");
  });

  it("回答済みの質問はリマインドも保留もしない", () => {
    const q = createQuery(log(), k4, T("2025-03-18"));
    answerQuery(log(), q.id, { option: "判定不能", answeredBy: "院長" }, T("2025-03-18"));
    expect(tickQueries(log(), T("2025-03-31"), cal)).toEqual({ reminded: [], held: [] });
  });
});
