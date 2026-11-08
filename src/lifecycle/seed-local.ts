// 院内ルールの種（spec FR-80。2026-11-07 ユーザー判断）：何年も積み上がった院内ルールの「積み上がり方」を見せる。
// ルールの中身は作り足さない（決定64：現場例は創作しない）。何の区分に関するものかだけを名前に出し、本文は伏せる。
// 区分で当てはめるので、算定画面のローカルルールの欄で「どれが引っかかったか」が分かる。
// 状態は本物の遷移（作成・承認・使用・トリガー・廃棄提案の承認）を古い日付で順に通して作る。古いまま使われていないものは、
// レセメン会議（使われない期間＝180 日のトリガー）で要再検証に回る
import { POINTS } from "../engine/points-2024";
import { applyEvent, createKnowledge, listKnowledge, type StoreOptions } from "./store";
import type { LifecycleEvent, SourceType } from "./types";

type Step = { at: string; event: LifecycleEvent };
type Seed = { slug: string; kubun: string; source: SourceType; created: string; steps: Step[]; empathy?: number };

const t = (d: string) => `${d}T10:00:00+09:00`;
const approve = (d: string): Step => ({ at: t(d), event: { type: "VERIFY_APPROVE" } });
const used = (d: string): Step => ({ at: t(d), event: { type: "USED" } });

export const LOCAL_SEEDS: Seed[] = [
  // 何年も前に作られ、承認されたまま使われていないもの（レセメン会議で要再検証に回る）
  { slug: "seed-01", kubun: "C002_2I1", source: "返戻", created: "2015-06-12", steps: [approve("2015-06-19")] },
  { slug: "seed-02", kubun: "C000", source: "手動", created: "2016-05-09", steps: [approve("2016-05-16"), used("2016-06-21")] },
  { slug: "seed-03", kubun: "C103_2", source: "返戻", created: "2016-02-15", steps: [approve("2016-02-22"), used("2016-09-12")] },
  { slug: "seed-04", kubun: "C002_N4_IKOU", source: "返戻", created: "2017-01-17", steps: [approve("2017-01-24")] },
  { slug: "seed-05", kubun: "C157_1", source: "手動", created: "2017-04-03", steps: [approve("2017-04-10")] },
  { slug: "seed-06", kubun: "D008_18", source: "返戻", created: "2018-11-20", steps: [approve("2018-11-27"), used("2019-03-11")] },
  { slug: "seed-07", kubun: "D400_1", source: "手動", created: "2019-07-01", steps: [approve("2019-07-08")] },
  // 使われ続けているもの
  { slug: "seed-08", kubun: "C001_N13_DX", source: "提案", created: "2022-10-03", steps: [approve("2022-10-11"), used("2024-12-25"), used("2025-02-26")] },
  { slug: "seed-09", kubun: "O100_3I", source: "提案", created: "2024-07-01", steps: [approve("2024-07-08"), used("2025-02-26")] },
  // 使われなくなって、すでにしまわれたもの（廃棄提案をベテランが承認）
  {
    slug: "seed-10",
    kubun: "C002_N10_HOKATSU",
    source: "返戻",
    created: "2020-03-09",
    steps: [
      approve("2020-03-16"),
      { at: t("2020-09-14"), event: { type: "TRIGGER", trigger: "idle" } },
      { at: t("2021-03-15"), event: { type: "IDLE_EXPIRED" } },
      { at: t("2021-04-12"), event: { type: "DISPOSAL_APPROVE", reason: "使われなくなったため（レセメン会議で確認）" } },
    ],
  },
  // 最近の提案で、まだ確かめていないもの
  { slug: "seed-11", kubun: "C001_N7_MITORI", source: "提案", created: "2025-02-20", steps: [], empathy: 2 },
  { slug: "seed-12", kubun: "D026_4", source: "提案", created: "2025-03-03", steps: [] },
];

const nameOf = (kubun: string) => POINTS[kubun]?.name ?? kubun;

/** 院内ルールの種を入れる（すでにあるものは入れない）。入れた知識の id を返す */
export function seedLocalRules(store: StoreOptions): string[] {
  const have = new Set(listKnowledge(store).map((m) => m.id));
  const made: string[] = [];
  for (const s of LOCAL_SEEDS) {
    if (have.has(`local/${s.slug}`)) continue;
    const name = nameOf(s.kubun);
    const meta = createKnowledge(
      store,
      {
        layer: "院内",
        slug: s.slug,
        summary: `${name}に関する院内ローカル`,
        body: [`# ${name}に関する院内ローカル`, "", "中身は伏せています（合成データのデモ。院内ルールの中身は作り足さない）。", "", `対象の区分：${name}（${s.kubun}）`].join("\n"),
        source: { type: s.source, ref: `seed:${s.slug}` },
        empathy: s.empathy ?? 0,
        match: { kubunAll: [s.kubun] },
      },
      t(s.created),
    );
    for (const step of s.steps) applyEvent(store, meta.id, step.event, step.at);
    made.push(meta.id);
  }
  return made;
}
