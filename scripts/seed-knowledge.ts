// 制度層の知識の初期投入（spec FR-38・FR-66：制度層の生成元は「初期投入」）。`npx tsx scripts/seed-knowledge.ts`
// ルールエンジンの R01〜R14 に 1 対 1 で対応する知識を knowledge/system/ に作り、.claude/skills/ に同期する
// 内容は design.md §2-3 のルール一覧（report-A 項目21。EM §5 で採用済み）に限る。判定はエンジンが行い、知識は理由の説明に使う
// 既にある知識は作り直さない（何度実行しても同じ）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "../src/engine";
import { createKnowledge, readKnowledge, type StoreOptions } from "../src/lifecycle/store";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 初期投入の時刻（合成レセプトの診療年月の初日。固定条件） */
export const SEED_AT = "2025-03-01T00:00:00+09:00";

/** design.md §2-3 のルール一覧の「内容」 */
export const RULE_TEXT: Record<string, string> = {
  R01: "在医総管の区分は同月の訪問診療の算定回数で決まる。訪問診療のない月の在医総管は算定できない",
  R02: "在宅酸素療法中など別表第八の二に当たる患者は重症区分（2イ）で算定する。重症区分に包括的支援加算は付けない",
  R03: "包括的支援加算は要介護3 以上で、かつ重症区分以外の患者に付ける",
  R04: "在宅療養指導管理料は主たるもの 1 つだけを算定する。材料加算はそれぞれ算定できる",
  R05: "在医総管を算定する月は、所定点数に含まれる項目（処方箋料とそれに付く加算を含む）を別に算定しない。院外処方なら処方箋を交付しない場合の加算は算定しない",
  R06: "特定疾患処方管理加算は主病が対象疾患のときに算定する。糖尿病・高血圧・脂質異常症は 2024 年 6 月から対象外",
  R07: "処方箋料は内服 7 種類以上で区分 2 を使う",
  R08: "外来・在宅ベースアップ評価料(Ⅰ)は、訪問診療の日は訪問診療時の区分、往診だけの日は再診時等の区分を使う",
  R09: "死亡診断加算と看取り加算は併算定できない。在宅ターミナルケア加算は死亡日前 14 日以内に 2 回以上の訪問が要る",
  R10: "緊急往診加算は対象患者に限る。訪問診療と同じ日の往診は原則算定できない。往診の翌日の訪問診療は在支診以外は算定できない",
  R11: "検体検査判断料は区分ごとに月 1 回。BNP は生化学的検査(Ⅱ)判断料。外来迅速検体検査加算は訪問診療では算定しない",
  R12: "在宅医療DX情報活用加算は、医療情報取得加算・医療DX推進体制整備加算と同月に併算定しない",
  R13: "週 3 回を超える訪問診療は、別表第七の疾病等か急性増悪のときに限る",
  R14: "在宅移行早期加算は、退院後に在宅療養を始めた患者で、在医総管の算定開始月から 3 か月目まで算定する",
};

export function seed(store: StoreOptions): string[] {
  const made: string[] = [];
  for (const rule of RULES) {
    const slug = rule.id.toLowerCase();
    const id = `system/${slug}`;
    if (readKnowledge(store, id)) continue;
    const text = RULE_TEXT[rule.id];
    if (!text) throw new Error(`内容がないルール: ${rule.id}`);
    createKnowledge(
      store,
      {
        layer: "制度",
        slug,
        summary: `${rule.id}：${text}`,
        body: [`# ${rule.id}`, "", text, "", `根拠：${rule.reference}`, "", `判定はルールエンジン（${rule.id}）が行う。この知識は判定の理由を説明するときに引用する。`].join("\n"),
        source: { type: "初期投入", ref: `design.md §2-3 ${rule.id}` },
        match: { ruleId: rule.id },
      },
      SEED_AT,
    );
    made.push(id);
  }
  return made;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const made = seed({ knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, ".claude", "skills") });
  console.log(made.length ? `作成: ${made.join(", ")}` : "作成なし（すべてある）");
}
