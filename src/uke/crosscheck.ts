// F4 の照合：UKE の傷病名（SY）と合成カルテの処方を突き合わせ、「病名と処方の不一致」を確認してほしい点として出す（spec FR-08）
// 不一致は医師に確かめる（AI は病名を作り足さない。spec 制約「データ」）。質問は 7 要件の検証を通る形で組み立てる
import type { QueryDraft } from "../query/doctor-query";
import type { UkePatient } from "./types";

export type Chart = {
  claimId: string;
  entries: { date: string; s: string; a: string; p: string }[];
  prescriptions: { date: string; category: string }[];
};

export type MismatchRule = {
  id: string;
  /** 処方の分類 */
  category: string;
  /** この処方の適応として、傷病名に要る語 */
  requires: RegExp;
  /** 傷病名のうち、確かめる対象（これに当たる名前があるときだけ出す） */
  target: RegExp;
  field: string;
  question: string;
  options: string[];
  why: string;
  /** メンターが医師に聞く前に読む説明（スキル crosscheck-<id> になる） */
  guide: string;
};

/** 不一致の規則（EM 5-1 の K4：DOAC と非弁膜症性心房細動。report-A 補足「AF」の読み） */
export const MISMATCH_RULES: MismatchRule[] = [
  {
    id: "M01",
    category: "DOAC",
    requires: /非弁膜症性心房細動/,
    target: /心房細動|^AF$/,
    field: "SY:心房細動の病型",
    question: "心房細動の病型について、診療録に記載がありません。該当するものを選んでください。",
    options: ["非弁膜症性心房細動", "弁膜症性心房細動", "その他", "判定不能"],
    why: "DOAC を処方しているが、傷病名が「心房細動」だけで病型が分からない",
    guide: "DOAC を処方している患者で、傷病名が「心房細動」だけのときは、非弁膜症性か弁膜症性かを医師に確認する。続き方（発作性・持続性など）ではなく、弁膜症との関係を聞く",
  },
];

export type Mismatch = { ruleId: string; claimId: string; disease: string; draft: QueryDraft };

/** 不一致を探す。確定済みの傷病名（医師の回答と承認で確定したもの）があれば、それも傷病名として見る */
export function crosscheck(patient: UkePatient, chart: Chart, confirmed: string[] = []): Mismatch[] {
  const names = [...patient.diseases.map((d) => d.name), ...confirmed];
  const out: Mismatch[] = [];
  for (const rule of MISMATCH_RULES) {
    const rx = chart.prescriptions.filter((p) => p.category === rule.category);
    if (rx.length === 0 || names.some((n) => rule.requires.test(n))) continue;
    const disease = names.find((n) => rule.target.test(n));
    if (!disease) continue;
    const indicators = [
      ...chart.entries.filter((e) => rule.target.test(e.a) || e.p.includes(rule.category)).map((e) => ({ source: `カルテ ${e.date}`, text: `A: ${e.a} / P: ${e.p}` })),
      ...rx.map((p) => ({ source: `処方 ${p.date}`, text: p.category })),
      { source: "傷病名", text: disease },
    ];
    out.push({
      ruleId: rule.id,
      claimId: chart.claimId,
      disease,
      draft: { claimId: chart.claimId, field: rule.field, why: rule.why, question: rule.question, indicators, options: rule.options, createdBy: "clerk" },
    });
  }
  return out;
}

/**
 * 照合の規則を、メンターが医師に聞く前に読むスキルにする（名前は crosscheck-<id>）。
 * 知識ライフサイクル（F5）の外にある決まった規則なので、状態を持たない（エンジンの判定と同じ扱い）
 */
export function crosscheckSkills(): { name: string; content: string }[] {
  return MISMATCH_RULES.map((r) => ({
    name: `crosscheck-${r.id.toLowerCase()}`,
    content: [
      "---",
      `name: crosscheck-${r.id.toLowerCase()}`,
      `description: ${JSON.stringify(`${r.id}（カルテとの照合）：${r.guide}`)}`,
      "---",
      "",
      `# ${r.id}（カルテとの照合）`,
      "",
      r.guide,
      "",
      `医師に聞くこと：${r.question}`,
      `選択肢：${r.options.join("／")}`,
      "",
      "照合はレセメンが決まった規則で行い、医師確認はこの決まった質問で送る（根拠：EM 5-1 K4「病名不一致 a-1 相当」）。",
      "",
    ].join("\n"),
  }));
}
