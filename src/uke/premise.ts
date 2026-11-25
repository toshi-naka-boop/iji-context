// 取り込んだレセプトの点検の、条件つきの指摘の「前提を確かめた」（採点 r4 医療事務課長 P1-1）。指摘を見分ける鍵を、画面とサーバーで同じ決まりで作る。
// 鍵は指摘の中身（ルール・文の種類・行やコード）だけから作り、患者の識別子を含めない。中身が変われば鍵も変わり、前の確かめは効かなくなる
import type { Finding } from "../engine/types";

/** 確かめた結果：notApplies＝前提に当たらない（このままでよい）／fix＝前提に当たるので、レセコンの側で直す */
export const PREMISE_OUTCOMES = ["notApplies", "fix"] as const;
export type PremiseOutcome = (typeof PREMISE_OUTCOMES)[number];
export const PREMISE_OUTCOME_LABEL: Record<PremiseOutcome, string> = { notApplies: "前提に当たらないと確かめた", fix: "前提に当たるので直す" };

/** 手書きのルールの条件つきの指摘（params.conditional が "1"。R20・R21 など） */
export const isConditionalHand = (f: Pick<Finding, "params">) => f.params?.conditional === "1";
export const handPremiseKey = (f: Pick<Finding, "ruleId" | "messageKey" | "lineRefs">) => `rule:${f.ruleId}:${f.messageKey}:${f.lineRefs.join(",")}`;
/** データで動く点検の指摘（certainty が条件つき） */
export const genericPremiseKey = (f: { check: string; messageKey: string; codes: { code: string }[] }) => `data:${f.check}:${f.messageKey}:${f.codes.map((c) => c.code).join(",")}`;

/** 点検の結果から、いま出ている条件つきの指摘の鍵を並べる（一覧の数え方と同じ） */
export function conditionalKeysOf(r: { findings: Pick<Finding, "ruleId" | "messageKey" | "lineRefs" | "params">[]; generic?: { findings: { check: string; messageKey: string; certainty: string; codes: { code: string }[] }[] } }): string[] {
  return [...r.findings.filter(isConditionalHand).map(handPremiseKey), ...(r.generic?.findings ?? []).filter((f) => f.certainty === "条件つき").map(genericPremiseKey)];
}
