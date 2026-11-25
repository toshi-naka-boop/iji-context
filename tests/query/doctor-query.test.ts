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
  sendQuery,
  tickQueries,
  validateQuery,
  type BusinessDays,
  type QueryDraft,
} from "../../src/query/doctor-query";
import { at, claimId, day } from "../helpers/period";

const cal = businessDays as BusinessDays;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "iji-query-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const log = () => ({ dir });

/** K4：カルテに「AF」のみ。DOAC 処方あり。病型を医師に確かめる */
const k4: QueryDraft = {
  claimId: claimId("K4"),
  field: "SY:心房細動の病型",
  why: "カルテの病名が「AF」のみで、病型が書かれていない",
  question: "心房細動の病型について、診療録に記載がありません。該当するものを選んでください。",
  indicators: [
    { source: `カルテ ${day(13)}（S/A）`, text: "AF。DOAC 継続" },
    { source: `処方 ${day(13)}`, text: "DOAC" },
  ],
  options: ["非弁膜症性心房細動", "弁膜症性心房細動", "その他", "判定不能"],
  createdBy: "mentor",
};
const T = (d: string) => `${d}T09:00:00+09:00`;

describe("K4 を流す（ask_missing → 医師確認 → 回答 → 承認）", () => {
  it("医師確認が 1 件でき、選択肢に「その他」「判定不能」があり、承認で SY が確定し、query-log/ に md と json が 1 組できる", () => {
    const r = askMissing(log(), { target: "doctor", ...k4 }, T(day(13)));
    expect(r.route).toBe("F1");
    const q = r.route === "F1" ? r.query : (() => { throw new Error(); })();
    expect(q.options).toEqual(expect.arrayContaining(["その他", "判定不能"]));
    expect(readdirSync(dir).sort()).toEqual([`${q.id}.json`, `${q.id}.md`]);
    answerQuery(log(), q.id, { option: "非弁膜症性心房細動", answeredBy: "院長" }, T(day(14)));
    const { query, confirmed } = approveQuery(log(), q.id, "院長", T(day(14)));
    expect(confirmed).toEqual({ claimId: claimId("K4"), queryId: q.id, name: "非弁膜症性心房細動", approver: "院長", at: T(day(14)) });
    expect(query.approval).toEqual({ approver: "院長", at: T(day(14)) });
    const md = readFileSync(path.join(dir, `${q.id}.md`), "utf8");
    expect(md).toContain(`承認: 院長 / ${day(14)}T09:00:00+09:00`);
    expect(md).toContain("- [x] 非弁膜症性心房細動");
    expect(readQuery(log(), q.id).status).toBe("承認済み");
  });

  it("回答だけでは SY は確定しない（承認が必要）。承認前に承認者名が空なら例外", () => {
    const q = createQuery(log(), k4, T(day(13)));
    expect(() => approveQuery(log(), q.id, "院長", T(day(13)))).toThrow(/承認できない/);
    answerQuery(log(), q.id, { option: "弁膜症性心房細動", answeredBy: "院長" }, T(day(14)));
    expect(() => approveQuery(log(), q.id, " ", T(day(14)))).toThrow(/承認者名/);
  });

  it("「判定不能」では SY は確定しない。「その他」は自由記述が必要で、その記述で確定する", () => {
    const a = createQuery(log(), k4, T(day(13)));
    answerQuery(log(), a.id, { option: "判定不能", answeredBy: "院長" }, T(day(14)));
    expect(approveQuery(log(), a.id, "院長", T(day(14))).confirmed).toBeNull();
    const b = createQuery(log(), { ...k4, field: "SY:別件" }, T(day(13)));
    expect(() => answerQuery(log(), b.id, { option: "その他", answeredBy: "院長" }, T(day(14)))).toThrow(/自由記述/);
    answerQuery(log(), b.id, { option: "その他", freeText: "発作性心房細動", answeredBy: "院長" }, T(day(14)));
    expect(approveQuery(log(), b.id, "院長", T(day(14))).confirmed?.name).toBe("発作性心房細動");
  });

  it("医療事務あての ask_missing は F3 に回り、医師確認は作らない", () => {
    const r = askMissing(log(), { target: "clerk", claimId: claimId("K3"), field: "受給者証の公費番号", why: "受給者証の写しがない" }, T(day(13)));
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
    expect(() => createQuery(log(), { ...k4, options: ["A", "B"] }, T(day(13)))).toThrow(/要件を満たさない/);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});

describe("⑦ 未回答：翌営業日にリマインド、3 営業日で保留（FR-34）", () => {
  // 基準月の 8 日（木）から。10・11 日は土日、12 日は祝日（スポーツの日。config/business-days.json）
  it("営業日は土日と祝日を除いて数える", () => {
    expect(cal.holidays).toContain(day(12));
    expect(businessDaysElapsed(T(day(8)), T(day(9)), cal)).toBe(1);
    expect(businessDaysElapsed(T(day(8)), T(day(13)), cal)).toBe(2); // 10・11 日は土日、12 日は祝日
    expect(businessDaysElapsed(T(day(8)), T(day(14)), cal)).toBe(3);
    expect(businessDaysElapsed(T(day(8)), at(12, "23:59:00"), cal)).toBe(1);
  });

  it("翌営業日にリマインド 1 回、3 営業日で保留。何度回しても同じ。保留の後に回答が来れば受け付ける", () => {
    const q = createQuery(log(), k4, T(day(8)));
    expect(tickQueries(log(), T(day(8)), cal)).toEqual({ reminded: [], held: [] });
    expect(tickQueries(log(), T(day(9)), cal)).toEqual({ reminded: [q.id], held: [] });
    expect(tickQueries(log(), T(day(13)), cal)).toEqual({ reminded: [], held: [] });
    expect(tickQueries(log(), T(day(14)), cal)).toEqual({ reminded: [], held: [q.id] });
    expect(tickQueries(log(), T(day(15)), cal)).toEqual({ reminded: [], held: [] });
    expect(readQuery(log(), q.id)).toMatchObject({ status: "保留", remindedAt: T(day(9)), heldAt: T(day(14)) });
    answerQuery(log(), q.id, { option: "非弁膜症性心房細動", answeredBy: "院長" }, T(day(15)));
    expect(readQuery(log(), q.id).status).toBe("回答済み");
  });

  it("送る前（メンターが書いた下書き）は、医療事務が送るまで回答できず、リマインドも保留もしない。送った日から数える（採点 r2 エンジニアの上司 #4）", () => {
    const r = askMissing(log(), { target: "doctor", ...k4, hold: true }, T(day(8)));
    const q = r.route === "F1" ? r.query : (() => { throw new Error(); })();
    expect(q.status).toBe("送る前");
    expect(Object.keys(readQuery(log(), q.id))).not.toContain("hold");
    expect(() => answerQuery(log(), q.id, { option: "判定不能", answeredBy: "院長" }, T(day(9)))).toThrow(/回答できない状態: 送る前/);
    expect(tickQueries(log(), T(day(14)), cal)).toEqual({ reminded: [], held: [] });
    expect(sendQuery(log(), q.id, T(day(14)))).toMatchObject({ status: "未回答", sentAt: T(day(14)) });
    expect(() => sendQuery(log(), q.id, T(day(14)))).toThrow(/送れない状態: 未回答/);
    expect(tickQueries(log(), T(day(14)), cal)).toEqual({ reminded: [], held: [] });
    expect(tickQueries(log(), T(day(15)), cal)).toEqual({ reminded: [q.id], held: [] });
  });

  it("回答済みの質問はリマインドも保留もしない", () => {
    const q = createQuery(log(), k4, T(day(8)));
    answerQuery(log(), q.id, { option: "判定不能", answeredBy: "院長" }, T(day(8)));
    expect(tickQueries(log(), T(day(30)), cal)).toEqual({ reminded: [], held: [] });
  });
});
