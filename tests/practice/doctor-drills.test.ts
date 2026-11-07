// 医師確認の練習問題（FR-76）：聞く前は情報不足（宛先は医師）、回答を戻すとユスティの判定が決まる。質問は 7 要件を満たす
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { validateQuery } from "../../src/query/doctor-query";
import { answerValue, DOCTOR_DRILLS, factQueryDraft, withAnswer } from "../../src/practice/doctor-drills";
import { loadCase } from "../engine/helpers";

const start = (id: string) => {
  const d = DOCTOR_DRILLS.find((x) => x.id === id)!;
  return d.make(loadCase(d.claimId.split("-")[0]));
};

describe("医師確認の練習問題", () => {
  it("m01：別表第八の二が分からないと、R02・R03 が情報不足（宛先は医師）。「該当する」を戻すと指摘なし", () => {
    const c = start("m01");
    const f = evaluate(c).findings;
    expect(f.map((x) => [x.ruleId, x.kind, x.missing?.target])).toEqual([["R02", "情報不足", "doctor"], ["R03", "情報不足", "doctor"]]);
    expect(evaluate(withAnswer(c, "table8_2", answerValue("table8_2", "該当する"))).findings).toEqual([]);
  });
  it("m02：週 4 回で急性増悪が分からないと R13 が情報不足。「あり」なら指摘なし、「なし」なら要件不足", () => {
    const c = start("m02");
    expect(evaluate(c).findings.map((x) => [x.ruleId, x.kind])).toEqual([["R13", "情報不足"]]);
    expect(evaluate(withAnswer(c, "acuteExacerbation", true)).findings).toEqual([]);
    expect(evaluate(withAnswer(c, "acuteExacerbation", false)).findings.map((x) => [x.ruleId, x.kind])).toEqual([["R13", "要件不足"]]);
  });
  it("「その他」「判定不能」は事実に戻さない", () => {
    expect(answerValue("table8_2", "判定不能")).toBeNull();
    expect(answerValue("acuteExacerbation", "その他")).toBeNull();
  });
  it("質問はどれも 7 要件の検査を通る", () => {
    expect(validateQuery(factQueryDraft("table8_2", start("m01"), "q0001"))).toEqual([]);
    expect(validateQuery(factQueryDraft("acuteExacerbation", start("m02"), "q0002"))).toEqual([]);
  });
  it("m03：K4 は要介護2 の事実でユスティの指摘はなく、照合（DOAC と病型）だけが残る", () => {
    expect(evaluate(start("m03")).findings).toEqual([]);
  });
});
