// design.md §7 #19：公的文書とローカルルールの突き合わせの判定規則（§4-6。FR-128〜131）
import path from "node:path";
import { describe, expect, it } from "vitest";
import { conflictKeys, docKey, judge, judgeAll } from "../../src/official/match";
import { loadRegistry } from "../../src/official/registry";
import { at } from "../helpers/period";
import { makeMeta } from "../lifecycle/helpers";
import { makeDoc, officialOf } from "./helpers";

const GEN = "R8";
/** 地域層・支払基金・東京都・C001・allow の知識（helpers の既定） */
const allow = (over = {}) => makeMeta({ polarity: "allow", ...over });
const avoid = (over = {}) => makeMeta({ polarity: "avoid", ...over });

describe("judge：§4-6 の表の 7 行", () => {
  it("1：その改定に適用しない文書は対象外（FR-131）", () => {
    expect(judge(allow(), makeDoc({ generations: ["R6"] }), GEN)).toBe("対象外");
    expect(judge(allow(), makeDoc({ generations: ["R6", "R8"] }), GEN)).toBe("整合");
  });
  it("2：区分が交わらなければ対象外。ruleId だけの知識は、その版のルールの区分で見る。区分のない知識は対象外", () => {
    expect(judge(allow(), makeDoc({ scope: { kubun: ["C002"] } }), GEN)).toBe("対象外");
    const byRule = makeMeta({ layer: "ベテラン", match: { ruleId: "R01" } });
    const ruleKubun = (id: string) => (id === "R01" ? ["C001"] : []);
    expect(judge(byRule, makeDoc(), GEN, ruleKubun)).toBe("整合");
    expect(judge(byRule, makeDoc(), GEN)).toBe("対象外");
    expect(judge(makeMeta({ layer: "院内", match: {} }), makeDoc(), GEN)).toBe("対象外");
    expect(judge(makeMeta({ layer: "院内", match: { kubunAll: [] } }), makeDoc(), GEN)).toBe("対象外");
  });
  it("3：審査支払機関・都道府県が両方決まっていて違えば対象外。片方が未設定なら対象外にしない", () => {
    const kokuho = allow({ match: { kubunAll: ["C001"], payer: "国保連", prefecture: "東京都" } });
    expect(judge(kokuho, makeDoc(), GEN)).toBe("対象外");
    expect(judge(kokuho, makeDoc({ scope: { payer: null } }), GEN)).toBe("整合");
    expect(judge(allow(), makeDoc({ scope: { prefecture: "大阪府" } }), GEN)).toBe("対象外");
    expect(judge(allow(), makeDoc({ scope: { prefecture: "東京都" } }), GEN)).toBe("整合");
    // 知識の側が未設定（院内層など）
    expect(judge(makeMeta({ layer: "院内", match: { kubunAll: ["C001"] } }), makeDoc({ scope: { prefecture: "大阪府" } }), GEN)).toBe("整合");
  });
  it("4：条件が両立しなければ対象外（同じ事実で値が違う・同じ区分の摘要コメントの有無が違う）。下限の条件は両立する", () => {
    const withFact = allow({ match: { kubunAll: ["C001"], facts: { table8_2: true, careLevelMin: 3 } } });
    expect(judge(withFact, makeDoc({ scope: { facts: { table8_2: false } } }), GEN)).toBe("対象外");
    expect(judge(withFact, makeDoc({ scope: { facts: { table8_2: true, careLevelMin: 1 } } }), GEN)).toBe("整合");
    expect(judge(allow({ match: { kubunAll: ["C001"], facts: { insurance: "国保" } } }), makeDoc({ scope: { facts: { insurance: "後期高齢者" } } }), GEN)).toBe("対象外");
    const withComment = allow({ match: { kubunAll: ["C001"], commentOn: [{ kubun: "C001", present: true }] } });
    expect(judge(withComment, makeDoc({ scope: { commentOn: [{ kubun: "C001", present: false }] } }), GEN)).toBe("対象外");
    expect(judge(withComment, makeDoc({ scope: { commentOn: [{ kubun: "C002", present: false }] } }), GEN)).toBe("整合");
    const months = allow({ match: { kubunAll: ["C001"], consecutiveMonths: { kubun: "C001", min: 2 } } });
    expect(judge(months, makeDoc({ scope: { consecutiveMonths: { kubun: "C001", min: 5 } } }), GEN)).toBe("整合");
  });
  it("5：文書が「条件つき」か、語彙で表せない条件を持てば、関連あり・未照合（向きが同じでも逆でも推し量らない）", () => {
    for (const meta of [allow(), avoid()]) {
      expect(judge(meta, makeDoc({ stance: "条件つき" }), GEN)).toBe("関連あり・未照合");
      expect(judge(meta, makeDoc({ scope: { conditionNote: "傷病名が確定のとき" } }), GEN)).toBe("関連あり・未照合");
      expect(judge(meta, makeDoc({ stance: "認めない", scope: { conditionNote: "傷病名が疑いのとき" } }), GEN)).toBe("関連あり・未照合");
    }
  });
  it("6：向きが同じなら整合（認める＝allow、認めない＝avoid）", () => {
    expect(judge(allow(), makeDoc({ stance: "認める" }), GEN)).toBe("整合");
    expect(judge(avoid(), makeDoc({ stance: "認めない" }), GEN)).toBe("整合");
  });
  it("7：逆の向きなら矛盾の恐れ", () => {
    expect(judge(avoid(), makeDoc({ stance: "認める" }), GEN)).toBe("矛盾の恐れ");
    expect(judge(allow(), makeDoc({ stance: "認めない" }), GEN)).toBe("矛盾の恐れ");
  });
});

describe("judgeAll：1 件の知識についてのまとめ", () => {
  const ok = makeDoc({ id: "X-1", stance: "認める" });
  const ng = makeDoc({ id: "X-2", stance: "認めない" });
  const cond = makeDoc({ id: "X-3", stance: "条件つき" });
  const other = makeDoc({ id: "X-4", scope: { kubun: ["C999"] } });

  it("4 つの結果：危ない側を優先し（矛盾の恐れ → 関連あり・未照合 → 整合）、1 件も当たらなければ公的根拠なし", () => {
    expect(judgeAll(allow(), [ok, ng, cond, other], GEN)).toEqual({ verdict: "矛盾の恐れ", approx: false, ids: { 矛盾の恐れ: ["X-2"], "関連あり・未照合": ["X-3"], 整合: ["X-1"] } });
    expect(judgeAll(allow(), [ok, cond, other], GEN).verdict).toBe("関連あり・未照合");
    expect(judgeAll(allow(), [ok, other], GEN).verdict).toBe("整合");
    expect(judgeAll(allow(), [other], GEN)).toEqual({ verdict: "公的根拠なし", approx: false, ids: { 矛盾の恐れ: [], "関連あり・未照合": [], 整合: [] } });
    expect(judgeAll(allow(), [], GEN).verdict).toBe("公的根拠なし");
  });
  it("文書の並びを入れ替えても結果が同じ", () => {
    const a = judgeAll(allow(), [ok, ng, cond, other, makeDoc({ id: "X-0", stance: "認めない" })], GEN);
    const b = judgeAll(allow(), [makeDoc({ id: "X-0", stance: "認めない" }), other, cond, ng, ok], GEN);
    expect(b).toEqual(a);
    expect(a.ids["矛盾の恐れ"]).toEqual(["X-0", "X-2"]);
  });
  it("近似の知識（条件の注記あり）と、条件の注記のない文書の組は、近似でない同じ知識と同じ結果になり、approx が真で返る（C-73）", () => {
    const note = { matchApprox: true, conditionNote: "通知の理由：（合成）" };
    for (const [meta, doc, want] of [
      [avoid(), ok, "矛盾の恐れ"],
      [avoid(), ng, "整合"],
      [allow(), ng, "矛盾の恐れ"],
      [allow(), ok, "整合"],
    ] as const) {
      const exact = judgeAll(meta, [doc], GEN);
      const approx = judgeAll({ ...meta, ...note }, [doc], GEN);
      expect(exact).toMatchObject({ verdict: want, approx: false });
      expect(approx).toEqual({ ...exact, approx: true });
    }
  });
});

describe("同梱のレジストリと K6 の地域知識（§3。X-65）", () => {
  const docs = loadRegistry(path.join(__dirname, "..", "..", "official"));
  /** K6 の合成の査定通知から作る地域知識と同じ形（avoid・近似・BNP・支払基金・東京都） */
  const k6 = makeMeta({
    id: "regional/k6-bnp",
    polarity: "avoid",
    matchApprox: true,
    conditionNote: "通知の理由：（合成）",
    match: { kubunAll: ["D008_19"], payer: "支払基金", prefecture: "東京都" },
  });

  it("SJ-133（確定病名への連月は認める）・SJ-319（疑いへの連月は認めない）のどちらとも「関連あり・未照合」で、出典に両方の id が出る。「整合」とは出さない", () => {
    const pair = docs.filter((d) => d.id === "SJ-133" || d.id === "SJ-319");
    expect(pair.map((d) => [d.id, d.stance, d.scope.conditionNote !== null])).toEqual([["SJ-133", "認める", true], ["SJ-319", "認めない", true]]);
    expect(judgeAll(k6, pair, GEN)).toEqual({ verdict: "関連あり・未照合", approx: true, ids: { 矛盾の恐れ: [], "関連あり・未照合": ["SJ-133", "SJ-319"], 整合: [] } });
  });
  it("レジストリの全部と突き合わせても「関連あり・未照合」で、当たるのは BNP の支払基金の文書だけ。矛盾の恐れにならないので ④ の鍵は空", () => {
    const all = judgeAll(k6, docs, GEN);
    expect(all.verdict).toBe("関連あり・未照合");
    expect(all.ids["関連あり・未照合"]).toEqual(["SJ-133", "SJ-154", "SJ-210", "SJ-286", "SJ-319", "SJ-89"]);
    expect(conflictKeys({ ...k6, status_since: at(14) }, officialOf(docs), at(20))).toEqual([]);
  });
  it("国保連の知識に、支払基金の文書は対象外（公的根拠なし）", () => {
    const kokuho = { ...k6, match: { ...k6.match, payer: "国保連" as const } };
    expect(judgeAll(kokuho, docs, GEN).verdict).toBe("公的根拠なし");
  });
  it("適用する改定が違えば、どの文書も当たらない", () => {
    expect(judgeAll(k6, docs, "R6").verdict).toBe("公的根拠なし");
  });
});

describe("文書の鍵", () => {
  it("要旨・URL・確認日・発出日・番号を直しても変わらず、立場・対象・適用する改定を直すと変わる", () => {
    const base = makeDoc();
    const key = docKey(base);
    expect(key).toMatch(/^X-1#[0-9a-f]{8}$/);
    expect(docKey(makeDoc({ summary: "直した要旨", url: "https://example.invalid/moved", checkedOn: "2030-01-01", issuedOn: "2030-01-01", number: "2" }))).toBe(key);
    expect(docKey(makeDoc({ stance: "認めない" }))).not.toBe(key);
    expect(docKey(makeDoc({ scope: { kubun: ["C001", "C002"] } }))).not.toBe(key);
    expect(docKey(makeDoc({ scope: { payer: null } }))).not.toBe(key);
    expect(docKey(makeDoc({ scope: { conditionNote: "条件" } }))).not.toBe(key);
    expect(docKey(makeDoc({ generations: ["R8", "R10"] }))).not.toBe(key);
    // 区分・改定の並び順だけの違いでは変わらない
    expect(docKey(makeDoc({ scope: { kubun: ["C002", "C001"] }, generations: ["R10", "R8"] }))).toBe(docKey(makeDoc({ scope: { kubun: ["C001", "C002"] }, generations: ["R8", "R10"] })));
  });
});

describe("conflictKeys：④ が使う、矛盾の恐れの文書の鍵", () => {
  const ng = makeDoc({ id: "X-2", stance: "認めない" });
  it("矛盾の恐れの文書の鍵だけを昇順で返す。④ が効かない層（制度）と、版のない年月は空", () => {
    const docs = [makeDoc({ id: "X-9", stance: "認めない" }), ng, makeDoc({ id: "X-1" }), makeDoc({ id: "X-3", stance: "条件つき" })];
    expect(conflictKeys(allow(), officialOf(docs), at(14))).toEqual([docKey(ng), docKey(docs[0])]);
    expect(conflictKeys(makeMeta({ layer: "制度", match: { ruleId: "R01", kubunAll: ["C001"] } }), officialOf(docs), at(14))).toEqual([]);
    expect(conflictKeys(allow(), { docs, generationOf: () => null }, at(14))).toEqual([]);
  });
  it("世代は now の年月（日本時間）で決める", () => {
    const seen: string[] = [];
    conflictKeys(allow(), { docs: [ng], generationOf: (ym) => (seen.push(ym), "R8") }, "2027-05-31T23:30:00Z");
    expect(seen).toEqual(["2027-06"]);
  });
});
