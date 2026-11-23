// 公的文書のテスト用の合成の文書（実在の文書ではない。id は「X-」で始め、EM の表の id と重ならないようにする）
import type { OfficialDoc, OfficialInput } from "../../src/official/types";
import { day } from "../helpers/period";

type DocOver = Partial<Omit<OfficialDoc, "scope">> & { scope?: Partial<OfficialDoc["scope"]> };

/** 既定は、支払基金・全国・C001 を条件なしに「認める」文書（R8 に適用） */
export function makeDoc(over: DocOver = {}): OfficialDoc {
  const { scope, ...rest } = over;
  return {
    id: "X-1",
    kind: "審査の一般的な取扱い",
    issuer: "合成の発出者",
    number: "1",
    issuedOn: day(1),
    url: "https://example.invalid/x-1",
    stance: "認める",
    summary: "合成の要旨",
    checkedOn: day(1),
    generations: ["R8"],
    ...rest,
    scope: { kubun: ["C001"], payer: "支払基金", prefecture: null, conditionNote: null, ...scope },
  };
}

/** どの年月も R8 として扱う入力（lifecycle のテストの日付は版の期間の外にもあるため） */
export const officialOf = (docs: OfficialDoc[]): OfficialInput => ({ docs, generationOf: () => "R8" });
