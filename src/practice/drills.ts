// 練習問題（spec FR-75。2026-11-07 ユーザー判断）：よくある間違いを入れた明細から始め、本人が直して確定し、ユスティが判定する。
// 間違いは report-A 項目 21 の 13 項目（ルールエンジンのテストの「違反あり」と同じもの）だけを使い、作り足さない。
// R01〜R12 の 12 問（R15・R16 の問題は足さない）。R13（週 4 回の訪問）は、直すのに医師への確認（急性増悪か）が要り、明細を直すだけでは正解にできないので外す。
// situation は問題を解くのに要る事実（答えではない）。画面とメンターに渡す。日付と請求 id は基準月（src/demo/period.ts）から作る
import { claimIdOf, dayOf, mdOf } from "../demo/period";
import type { ClaimContext, ClaimEvent, ClaimLine } from "../engine/types";

export type Drill = { id: string; ruleId: string; claimId: string; situation: string[]; make: (base: ClaimContext) => ClaimContext };

/** 症例の日付（K1・K2 の訪問診療は 14 日と 28 日。22 日は訪問診療のない平日） */
const FIRST = 14;
const SECOND = 28;
const OUSHIN_ONLY = 22;
const K1 = claimIdOf("K1");
const K2 = claimIdOf("K2");

const line = (kubun: string, count = 1, dates: string[] = [dayOf(FIRST)]): ClaimLine => ({ kubun, count, dates });
const without = (c: ClaimContext, ...k: string[]): ClaimContext => ({ ...c, lines: c.lines.filter((l) => !k.includes(l.kubun)) });
const withLines = (c: ClaimContext, ...ls: ClaimLine[]): ClaimContext => ({ ...c, lines: [...c.lines, ...ls] });
const withEvents = (c: ClaimContext, ...es: ClaimEvent[]): ClaimContext => ({ ...c, events: [...c.events, ...es] });

const RX_DAY = [dayOf(SECOND)];
const NO_KANRI_MONTH = `今月は在医総管を算定しない月で、院外処方の処方箋を ${mdOf(SECOND)} に交付した`;

/** 在医総管のない月（処方箋料を算定する月）にした K1 */
const noKanri = (k1: ClaimContext) =>
  withLines(without(k1, "C002_2I1", "C002_N15_RENKEI"), line("F400_3", 1, RX_DAY), line("F400_N4", 1, RX_DAY), line("F400_N6_1", 1, RX_DAY));

export const DRILLS: Drill[] = [
  { id: "d00", ruleId: "R01", claimId: K1, situation: [`今月は ${mdOf(FIRST)} と ${mdOf(SECOND)} に訪問診療をした`], make: (k) => without(k, "C001_1I", "O001_3I", "O100_1HA") },
  { id: "d01", ruleId: "R02", claimId: K1, situation: [], make: (k) => withLines(without(k, "C002_2I1"), line("C002_2RO1", 1, [dayOf(SECOND)])) },
  {
    id: "d02",
    ruleId: "R03",
    claimId: K2,
    situation: ["要介護度は要介護2（介護保険証で確認済み）"],
    make: (k) => ({ ...k, facts: { ...k.facts, careLevel: { known: true, value: 2 } } }),
  },
  { id: "d03", ruleId: "R04", claimId: K1, situation: [], make: (k) => withLines(k, line("C101_2I")) },
  { id: "d04", ruleId: "R05", claimId: K1, situation: [], make: (k) => withLines(k, line("B000")) },
  {
    id: "d05",
    ruleId: "R06",
    claimId: K2,
    situation: [NO_KANRI_MONTH],
    make: (k) => withLines(without(k, "C002_2RO1", "C002_N4_IKOU", "C002_N10_HOKATSU"), line("F400_3", 1, RX_DAY), line("F400_N4", 1, RX_DAY)),
  },
  {
    id: "d06",
    ruleId: "R07",
    claimId: K1,
    situation: [NO_KANRI_MONTH, `${mdOf(SECOND)} の処方は内服薬 7 種類`],
    make: (k) => {
      const c = noKanri(k);
      return { ...c, events: c.events.map((e) => (e.type === "prescription" ? { ...e, oralKinds: 7 } : e)) };
    },
  },
  {
    id: "d07",
    ruleId: "R08",
    claimId: K1,
    situation: [`${mdOf(OUSHIN_ONLY)} は往診だけの日（訪問診療はしていない）`],
    make: (k) =>
      withEvents(
        withLines(
          { ...k, lines: k.lines.map((l) => (l.kubun === "O001_3I" ? { ...l, count: l.count + 1, dates: [...l.dates, dayOf(OUSHIN_ONLY)] } : l)) },
          line("C000", 1, [dayOf(OUSHIN_ONLY)]),
        ),
        { type: "oushin", date: dayOf(OUSHIN_ONLY), kind: "normal" },
      ),
  },
  {
    id: "d08",
    ruleId: "R09",
    claimId: K1,
    situation: [`${mdOf(SECOND)} に自宅で亡くなり、看取った`],
    make: (k) => withEvents(withLines(k, line("C001_N7_MITORI", 1, [dayOf(SECOND)]), line("C001_N8_SHIBOU", 1, [dayOf(SECOND)])), { type: "death", date: dayOf(SECOND) }),
  },
  {
    // 同じ日に往診料を足すだけだと「別々の診療か」の確認（情報不足）になるので、確かめた答えを入れて、違反を探す題材に保つ
    id: "d09",
    ruleId: "R10",
    claimId: K1,
    situation: [`${mdOf(FIRST)} の訪問診療料と往診料は、同じ 1 回の診療のもの（別々の診療ではないと確認済み）`],
    make: (k) => ({
      ...withEvents(withLines(k, line("C000", 1, [dayOf(FIRST)])), { type: "oushin", date: dayOf(FIRST), kind: "normal" }),
      facts: { ...k.facts, sameDaySeparate: { known: true, value: { [dayOf(FIRST)]: false } } },
    }),
  },
  { id: "d10", ruleId: "R11", claimId: K1, situation: [], make: (k) => without(k, "D026_5") },
  { id: "d11", ruleId: "R12", claimId: K1, situation: [], make: (k) => withLines(k, line("A_DENSHI_RENKEI")) },
];

export function drillOf(id: string): Drill {
  const d = DRILLS.find((x) => x.id === id);
  if (!d) throw new Error(`練習問題がない: ${id}`);
  return d;
}

/** 一覧に出す形（答え＝どのルールかは出さない） */
export const drillList = () => DRILLS.map((d, i) => ({ id: d.id, no: i + 1, claimId: d.claimId, situation: d.situation }));
