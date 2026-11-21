// 院内ルールの種（spec FR-80。2026-11-07 ユーザー判断）：何年も積み上がった院内ルールの「積み上がり方」を見せる。
// ルールの中身は作り足さない（決定64：現場例は創作しない）。何の区分に関するものかだけを名前に出し、本文は伏せる。
// 区分で当てはめるので、算定画面のローカルルールの欄で「どれが引っかかったか」が分かる。
// 状態は本物の遷移（作成・承認・使用・トリガー・廃棄提案の承認）を古い日付で順に通して作る。古いまま使われていないものは、
// レセメン会議（使われない期間＝180 日のトリガー）で要再検証に回る
import { dateFrom, period } from "../demo/period";
import { resolveRevision } from "../engine/revisions";
import { applyEvent, createKnowledge, listKnowledge, type StoreOptions } from "./store";
import type { LifecycleEvent, SourceType } from "./types";
import { conflictKeys } from "../official/match";
import type { OfficialInput } from "../official/types";

type Step = { at: string; event: LifecycleEvent };
type Seed = { slug: string; kubun: string; source: SourceType; created: string; steps: Step[]; empathy?: number };

/** 基準月（config/demo.json）から months か月ずらした月の day 日。固定の年を書かない（spec FR-80） */
const d = dateFrom;
const t = (date: string) => `${date}T10:00:00+09:00`;
const approve = (d: string): Step => ({ at: t(d), event: { type: "VERIFY_APPROVE" } });
const used = (d: string): Step => ({ at: t(d), event: { type: "USED" } });

export const LOCAL_SEEDS: Seed[] = [
  // 何年も前に作られ、承認されたまま使われていないもの（レセメン会議で要再検証に回る）
  { slug: "seed-01", kubun: "C002_2I1", source: "返戻", created: d(-117, 12), steps: [approve(d(-117, 19))] },
  { slug: "seed-02", kubun: "C000", source: "手動", created: d(-106, 9), steps: [approve(d(-106, 16)), used(d(-105, 21))] },
  { slug: "seed-03", kubun: "C103_2", source: "返戻", created: d(-109, 15), steps: [approve(d(-109, 22)), used(d(-102, 12))] },
  { slug: "seed-04", kubun: "C002_N4_IKOU", source: "返戻", created: d(-98, 17), steps: [approve(d(-98, 24))] },
  { slug: "seed-05", kubun: "C157_1", source: "手動", created: d(-95, 3), steps: [approve(d(-95, 10))] },
  { slug: "seed-06", kubun: "D008_19", source: "返戻", created: d(-76, 20), steps: [approve(d(-76, 27)), used(d(-72, 11))] },
  { slug: "seed-07", kubun: "D400_1", source: "手動", created: d(-68, 1), steps: [approve(d(-68, 8))] },
  // 使われ続けているもの
  { slug: "seed-08", kubun: "C001_N13_DX", source: "提案", created: d(-29, 3), steps: [approve(d(-29, 11)), used(d(-3, 25)), used(d(-1, 26))] },
  { slug: "seed-09", kubun: "O001_3I", source: "提案", created: d(-8, 1), steps: [approve(d(-8, 8)), used(d(-1, 26))] },
  // 使われなくなって、すでにしまわれたもの（廃棄提案をベテランが承認）
  {
    slug: "seed-10",
    kubun: "C002_N10_HOKATSU",
    source: "返戻",
    created: d(-60, 9),
    steps: [
      approve(d(-60, 16)),
      { at: t(d(-54, 14)), event: { type: "TRIGGER", trigger: "idle" } },
      { at: t(d(-48, 15)), event: { type: "IDLE_EXPIRED" } },
      { at: t(d(-47, 12)), event: { type: "DISPOSAL_APPROVE", reason: "使われなくなったため（レセメン会議で確認）" } },
    ],
  },
  // 最近の提案で、まだ確かめていないもの
  { slug: "seed-11", kubun: "C001_N7_MITORI", source: "提案", created: d(-1, 20), steps: [], empathy: 2 },
  { slug: "seed-12", kubun: "D026_4", source: "提案", created: d(0, 3), steps: [] },
];

/** 区分の名前は基準月の版の点数表から取る */
const nameOf = (kubun: string) => resolveRevision(period.yearMonth).points[kubun]?.name ?? kubun;

/** 種として入った知識か（種を入れる処理が source_event.ref に付けている印） */
const SEED_REF = "seed:";

/**
 * 種として承認済みで入った知識に、その時点で矛盾の恐れになる公的文書を「確認済み」として記録する（OFFICIAL_BASELINE。design.md §4-3）。
 * これらの矛盾は、ローカルルール欄には出続け、トリガー④だけが黙る。後から足した・直した文書では ④ が出る。
 * now は種の遷移の古い日付ではなく、種を入れた時点の時計にする（古い日付だと、その年月の版がなく鍵が空になる）。
 * 種でない承認済みの知識（ベテランが承認したものなど）には出さない。記録した知識の id を返す。
 * 段 4 を、作り直さないデータに後から入れるときも、同じ操作を 1 回行う（only を省くと種の全部が対象）
 */
export function baselineSeeds(store: StoreOptions, official: OfficialInput, now: string, only?: string[]): string[] {
  const done: string[] = [];
  for (const m of listKnowledge(store)) {
    if (m.status !== "承認済み" || !m.source_event.ref.startsWith(SEED_REF)) continue;
    if (only && !only.includes(m.id)) continue;
    const keys = conflictKeys(m, official, now).filter((k) => !m.official_seen.includes(k));
    if (keys.length === 0) continue;
    applyEvent(store, m.id, { type: "OFFICIAL_BASELINE", officialKeys: keys }, now, { officialIds: keys });
    done.push(m.id);
  }
  return done;
}

/**
 * 院内ルールの種を入れる（すでにあるものは入れない）。入れた知識の id を返す。
 * baseline を渡すと、最後に、入れた種のうち承認済みのものに OFFICIAL_BASELINE を出す
 */
export function seedLocalRules(store: StoreOptions, baseline?: { official: OfficialInput; now: string }): string[] {
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
        source: { type: s.source, ref: `${SEED_REF}${s.slug}` },
        empathy: s.empathy ?? 0,
        match: { kubunAll: [s.kubun] },
      },
      t(s.created),
    );
    for (const step of s.steps) applyEvent(store, meta.id, step.event, step.at);
    made.push(meta.id);
  }
  if (baseline && made.length > 0) baselineSeeds(store, baseline.official, baseline.now, made);
  return made;
}
