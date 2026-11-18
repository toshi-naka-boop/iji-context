// 制度層の知識の初期投入（spec FR-38・FR-66：制度層の生成元は「初期投入」）。`npx tsx scripts/seed-knowledge.ts`
// ルールエンジンの R01〜R16（基準月の版のルール）に 1 対 1 で対応する知識を knowledge/system/ に作り、.claude/skills/ に同期する
// 内容は design.md §2-3 のルール一覧（令和8年度改定後。EM の採用値）に限る。文に点数は書かない（値の変更の版で文が古くならないように）。
// 判定はエンジンが行い、知識は理由の説明に使う
// 既にある知識は作り直さない（何度実行しても同じ）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { period } from "../src/demo/period";
import { rulesOf } from "../src/engine";
import { isKnownKubun } from "../src/engine/codes-fictional";
import { createKnowledge, readKnowledge, type StoreOptions } from "../src/lifecycle/store";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 初期投入の時刻（基準月の初日。直近の改定日より後なので、種を入れた直後の会議で制度層が要再検証にならない。design.md §3-1） */
export const SEED_AT = period.seedAt;

/** design.md §2-3 のルール一覧の「内容」 */
export const RULE_TEXT: Record<string, string> = {
  R01: "管理料（在宅時医学総合管理料・施設入居時等医学総合管理料）の区分は、同じ月に算定した訪問診療料の回数で決まる。訪問診療料のない月は算定できない。注16 の基準を満たさない施設は、月 2 回以上でも月 1 回の区分（2ニ）で算定する（重症区分は除く）",
  R02: "在宅酸素療法中など別表第八の二に当たる患者に、月 2 回以上訪問診療を行った月は、重症区分（2イ）で算定する。重症区分で算定する月に包括的支援加算は付けない",
  R03: "包括的支援加算は、管理料の区分が 2ロ・2ニ の月に、別表第八の三の状態（要介護3 以上、認知症の日常生活自立度Ⅲ以上、週 1 回以上の訪問看護、訪問診療・訪問看護での処置、麻薬の投薬など）の患者に付ける。要介護3 未満でも、ほかの状態に当たれば対象。施設入居時等医学総合管理料でも同じ",
  R04: "在宅療養指導管理料は主たるもの 1 つだけを算定する。材料加算はそれぞれ算定できる",
  R05: "管理料（在宅時医学総合管理料・施設入居時等医学総合管理料）を算定する月は、所定点数に含まれる項目（処方箋料とそれに付く加算を含む）を別に算定しない。院外処方なら処方箋を交付しない場合の加算は算定しない",
  R06: "特定疾患処方管理加算は主病が対象疾患のときに算定する。糖尿病・高血圧・脂質異常症は対象外。28 日以上の処方が要る",
  R07: "処方箋料は内服 7 種類以上で区分 2 を使う",
  R08: "外来・在宅ベースアップ評価料(Ⅰ)は、訪問診療料を算定した日は訪問診療時の区分、往診料だけの日は再診時等の区分を使う。訪問診療料と往診料の両方を算定した日に再診時等を重ねられるかは、施設で確かめた設定による",
  R09: "死亡診断加算と看取り加算は併算定できない。在宅ターミナルケア加算は死亡日前 14 日以内に 2 回以上の訪問が要る",
  R10: "緊急往診加算は対象患者に限る。1 回の診療に訪問診療料と往診料の両方は算定しない。往診料を算定した日とその翌日の訪問診療料は、在宅療養支援診療所が連絡担当者・往診担当医などを文書で提供している患者に限って算定できる",
  R11: "検体検査判断料は区分ごとに月 1 回。BNP は生化学的検査(Ⅱ)判断料。外来迅速検体検査加算は、当日中に結果を説明し文書で提供したことを確かめてから算定する",
  R12: "在宅医療DX情報活用加算は、電子的診療情報連携体制整備加算と同じ月に併算定しない。加算1・加算2 は届出の区分に合わせる",
  R13: "週 3 回を超える訪問診療料は、別表第七の疾病等か急性増悪のときに限る。週は日曜から土曜で数える",
  R14: "在宅移行早期加算は、退院後に在宅療養を始めた患者で、管理料の算定開始月から 3 か月目まで、退院から 1 年以内に算定する",
  R15: "外来・在宅物価対応料は、訪問診療料を算定した日は訪問診療時の区分、往診料だけの日は再診時等の区分を使う。訪問診療料と往診料の両方を算定した日に再診時等を重ねられるかは、施設で確かめた設定による",
  R16: "管理料は、居宅の患者は在宅時医学総合管理料、有料老人ホームなどの施設に入居している患者は施設入居時等医学総合管理料で算定する",
};

export function seed(store: StoreOptions): string[] {
  const made: string[] = [];
  for (const rule of rulesOf(period.yearMonth)) {
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
  const made = seed({ knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, ".claude", "skills"), knownKubun: isKnownKubun });
  console.log(made.length ? `作成: ${made.join(", ")}` : "作成なし（すべてある）");
}
