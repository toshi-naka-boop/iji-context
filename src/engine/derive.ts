// deriveLines(input, rev)：出来事と確かめた事実から、算定行を決定的に導出する（design.md §2-8。spec FR-94〜103）
// 決めるのは「どの区分を何回・どの日に立てるか」だけ。要件（背反・要件不足・週の限度など）は evaluate が判定する。
// 判定の述語は predicates.ts のものを検証（ルール）と共有する。LLM は使わない（src/mentor と LLM の SDK を import しない）
import { targetOfNeed } from "./index";
import {
  billedVisitDays,
  expectedKanri,
  hokatsuEligible,
  ikouEligible,
  kanriKubun,
  oushinOnlyBilledDays,
  rxManyOral,
  terminalVisitsOk,
  visitBillable,
  visitKubunOn,
} from "./predicates";
import { resolveRevision } from "./revisions";
import type { Revision, RevisionConsts } from "./revisions/types";
import { addDays, eventsOf } from "./rules/util";
import type { ClaimContext, ClaimEvent, ClaimLine, Facility, Facts, NeedKey } from "./types";

export type DeriveInput = {
  yearMonth: string;
  facility: Facility;
  facts: Facts;
  events: ClaimEvent[];
  history?: ClaimContext["history"];
  /** 導出しない区分の行（入力どおりに通す） */
  manual: ClaimLine[];
  /** 要選択への答え（pending の id → 選んだ選択肢の id） */
  choices: Record<string, string>;
  /** 月の途中の日付（"YYYY-MM-DD"）。出来事は、呼び出し側が先に contextAsOf で絞っておく */
  asOf?: string;
};

type EventRef = { type: ClaimEvent["type"]; date: string };

export type LineBasis = {
  kubun: string;
  dates: string[];
  /** 導出規則の id（D01…） */
  derive: string;
  events: EventRef[];
  /** 使った事実・施設の設定 */
  needs: NeedKey[];
  /** 要選択の答えで立てたとき、その pending の id */
  choice?: string;
  /** 月の途中で、月末までに変わり得る */
  tentative: boolean;
};

export type PendingOption = { id: string; label: string; kubun: string[] };
export type Pending =
  /** date は、日付ごとの事実（sameDaySeparate）の対象の日 */
  | { kind: "事実不足"; id: string; need: NeedKey; target: "doctor" | "clerk"; blocks: string[]; date?: string }
  | { kind: "要選択"; id: string; question: string; options: PendingOption[]; blocks: string[] };

export type Unsupported = { code: "kyokagata" | "single_building_multi" | "baseup_note5" | "unmapped_test_item"; detail: string };

export type DeriveResult = {
  revisionId: string;
  /** 導出した行（D の順）＋ manual（入力の順） */
  lines: ClaimLine[];
  /** 導出した行と 1 対 1 */
  basis: LineBasis[];
  pending: Pending[];
  unsupported: Unsupported[];
  /** withheld：pending か unsupported がある（合計を出さない）。tentative：asOf あり（合計に「見込み」を付ける） */
  totalStatus: "ok" | "tentative" | "withheld";
  /** 今の pending にない id への答え（無視した） */
  staleChoices: string[];
  /** 出来事はあるが行を立てなかったもの（§2-3-4） */
  notBilled: { event: EventRef; reason: "after_oushin" | "same_encounter" }[];
};

/** 導出する区分（版の定数から決まる）。これ以外の区分は manual で入力どおりに通す */
export function derivedKubun(c: RevisionConsts): string[] {
  return [
    ...c.visitKubun,
    c.oushin.kubun,
    c.oushin.revisit,
    c.oushin.kinkyu,
    ...kanriKubun(c),
    c.hokatsu.kubun,
    c.ikou.kubun,
    ...Object.values(c.dx.tiers),
    ...c.baseUp.visit,
    c.baseUp.revisit,
    ...c.price.visit,
    c.price.revisit,
    c.tests.bloodDraw,
    ...Object.values(c.testItems).map((t) => t.kubun),
    ...c.tests.judgement,
    c.rx.many,
    c.rx.other,
    c.terminal.mitori,
    c.terminal.shibou,
    c.terminal.terminal,
  ];
}

/** 行のうち、導出しない区分のものだけ（deriveLines の manual に渡す） */
export function manualLinesOf(lines: ClaimLine[], rev: Revision): ClaimLine[] {
  const derived = new Set(derivedKubun(rev.consts));
  return lines.filter((l) => !derived.has(l.kubun));
}

/** 同じ日の訪問診療・往診をどうするか。bill＝立てる／hold＝保留（答えを待つ）／skip＝立てない */
type Decision = "bill" | "hold" | "skip";

export function deriveLines(input: DeriveInput, rev: Revision = resolveRevision(input.yearMonth)): DeriveResult {
  const c = rev.consts;
  const derived = new Set(derivedKubun(c));
  const bad = input.manual.find((l) => derived.has(l.kubun));
  if (bad) throw new Error(`manual に導出する区分が入っている: ${bad.kubun}`);

  const { facility, facts } = input;
  const lines: ClaimLine[] = [];
  const basis: LineBasis[] = [];
  const pending: Pending[] = [];
  const unsupported: Unsupported[] = [];
  const notBilled: DeriveResult["notBilled"] = [];
  const asked = new Set<string>();
  // 述語に渡す請求。行は「ここまでに立てた行」（lines は同じ配列を指す）。請求 id・審査支払機関は述語が見ないので空・仮の値
  const ctx: ClaimContext = { claimId: "", yearMonth: input.yearMonth, facility, payer: "国保連", prefecture: facility.prefecture, facts, events: input.events, lines, history: input.history };

  const ref = (e: EventRef): EventRef => ({ type: e.type, date: e.date });
  function add(kubun: string, dates: string[], b: { derive: string; events: EventRef[]; needs?: NeedKey[]; choice?: string; tentative?: boolean }) {
    if (dates.length === 0) return;
    const sorted = [...dates].sort();
    lines.push({ kubun, count: sorted.length, dates: sorted });
    basis.push({ kubun, dates: sorted, derive: b.derive, events: b.events.map(ref), needs: b.needs ?? [], ...(b.choice ? { choice: b.choice } : {}), tentative: b.tentative ?? false });
  }
  const lack = (id: string, need: NeedKey, blocks: string[], date?: string) => pending.push({ kind: "事実不足", id, need, target: targetOfNeed(need), blocks, ...(date ? { date } : {}) });
  /** 要選択。答えが選択肢にあればその id を返し、なければ pending に出す（本人が選ぶまで行にしない。FR-97） */
  function ask(id: string, question: string, options: PendingOption[], blocks: string[]): string | undefined {
    asked.add(id);
    const picked = input.choices[id];
    if (picked !== undefined && options.some((o) => o.id === picked)) return picked;
    pending.push({ kind: "要選択", id, question, options, blocks });
    return undefined;
  }

  const byDate = <T extends { date: string }>(xs: T[]) => [...xs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const visits = byDate(eventsOf(ctx, "visit"));
  const oushins = byDate(eventsOf(ctx, "oushin"));
  const rxs = byDate(eventsOf(ctx, "prescription"));
  const visitKubunOf = (e: { sameBuildingCount: number }) => (e.sameBuildingCount >= 2 ? c.visitKubun[1] : c.visitKubun[0]);
  /** 訪問診療料の回数に依存する区分（管理料と、それに付く加算。管理料が決まらない間は処方箋料も） */
  const kanriBlocks = [...kanriKubun(c), c.hokatsu.kubun, c.ikou.kubun, ...(rxs.length ? [c.rx.many, c.rx.other] : [])];
  /** その日の訪問診療料・往診料に付く区分 */
  const dayBlocks = [...c.baseUp.visit, c.baseUp.revisit, ...c.price.visit, c.price.revisit];

  if (facility.kyokagata) unsupported.push({ code: "kyokagata", detail: "機能強化型の在宅療養支援診療所の点数は扱っていません" });

  // --- D01・D02：訪問診療料と往診料（§2-3-4）。同じ日の両方は、出来事だけでは立てない
  const separate = facts.sameDaySeparate.known ? facts.sameDaySeparate.value : {};
  const sameDay = new Map<string, { visit: Decision | "check"; oushin: Decision }>();
  for (const d of [...new Set(visits.map((v) => v.date))].filter((x) => oushins.some((o) => o.date === x))) {
    const visitK = [...new Set(visits.filter((v) => v.date === d).map(visitKubunOf))];
    const blocks = [...visitK, c.oushin.kubun, ...dayBlocks, ...kanriBlocks];
    const answer = separate[d];
    if (answer === undefined) {
      lack(`D01-sameDay:${d}`, "sameDaySeparate", blocks, d);
      sameDay.set(d, { visit: "hold", oushin: "hold" });
    } else if (answer === false) {
      const id = `D01-encounter:${d}`;
      const picked = ask(id, "同じ日の訪問診療と往診は 1 回の診療です。診療の中身に合うほうを選んでください", [
        { id: "visit", label: "訪問診療料（定期の訪問診療）", kubun: visitK },
        { id: "oushin", label: "往診料（求めに応じた往診）", kubun: [c.oushin.kubun] },
      ], blocks);
      sameDay.set(d, picked === undefined ? { visit: "hold", oushin: "hold" } : picked === "visit" ? { visit: "bill", oushin: "skip" } : { visit: "skip", oushin: "bill" });
      if (picked === "visit") for (const o of oushins.filter((x) => x.date === d)) notBilled.push({ event: ref(o), reason: "same_encounter" });
      if (picked === "oushin") for (const v of visits.filter((x) => x.date === d)) notBilled.push({ event: ref(v), reason: "same_encounter" });
    } else sameDay.set(d, { visit: "check", oushin: "bill" });
  }
  const oushinDecision = (date: string): Decision => sameDay.get(date)?.oushin ?? "bill";
  /** 訪問診療料を立てるか。往診と同じ日（別々の診療）・往診の翌日は、制限の判定（visitBillable。R10 と共有）で決める */
  function visitDecision(v: (typeof visits)[number]): Decision {
    const same = sameDay.get(v.date);
    if (same && same.visit !== "check") return same.visit;
    const prev = addDays(v.date, -1);
    const afterOushin = same !== undefined || (oushins.some((o) => o.date === prev) && oushinDecision(prev) !== "skip");
    if (!afterOushin) return "bill";
    const ok = visitBillable(ctx);
    if (ok === true) return "bill";
    if (ok === "unknown") {
      lack(`D01-doc:${v.date}`, "contactDocProvided", [visitKubunOf(v), ...dayBlocks, ...kanriBlocks], v.date);
      return "hold";
    }
    notBilled.push({ event: ref(v), reason: "after_oushin" });
    return "skip";
  }
  const decided = visits.map((v) => ({ v, d: visitDecision(v) }));
  const visitHeld = decided.some((x) => x.d === "hold");
  const billedVisits = decided.filter((x) => x.d === "bill").map((x) => x.v);
  for (const k of c.visitKubun) {
    const mine = billedVisits.filter((v) => visitKubunOf(v) === k);
    add(k, mine.map((v) => v.date), { derive: "D01", events: mine, needs: sameDay.size ? ["sameDaySeparate"] : [] });
  }
  const billedOushins = oushins.filter((o) => oushinDecision(o.date) === "bill");
  add(c.oushin.kubun, billedOushins.map((o) => o.date), { derive: "D02", events: billedOushins });
  // 往診料と併せて再診料（留意 C001 (11)。L-40 の推奨案）。訪問診療料も立てた日には重ねない（算定を増やさない側）
  const visitDaySet = new Set(billedVisits.map((v) => v.date));
  const revisitOushins = billedOushins.filter((o) => !visitDaySet.has(o.date));
  add(c.oushin.revisit, revisitOushins.map((o) => o.date), { derive: "D02", events: revisitOushins });
  const emergencies = billedOushins.filter((o) => o.kind === "emergency");
  if (emergencies.length) {
    if (!facts.emergencyEligible.known) lack(`D02-kinkyu:${input.yearMonth}`, "emergencyEligible", [c.oushin.kinkyu]);
    else if (facts.emergencyEligible.value) add(c.oushin.kinkyu, emergencies.map((o) => o.date), { derive: "D02", events: emergencies, needs: ["emergencyEligible"] });
  }

  // --- D03〜D05：管理料と、それに付く加算。回数は D01 で立てた訪問診療料の回数
  const visitDays = billedVisitDays(ctx, c);
  const tentative = input.asOf !== undefined;
  let kanri: { kubun: string; tier: string; date: string } | undefined;
  /** 管理料を立てるかが決まっていない（保留か未対応）。決まるまで、処方箋料（D10）も立てない */
  let kanriOpen = false;
  const care = facts.comprehensiveCare;
  if (visitHeld) kanriOpen = true;
  else if (!care.known) {
    lack(`D03-care:${input.yearMonth}`, "comprehensiveCare", kanriBlocks);
    kanriOpen = true;
  } else if (care.value) {
    const { family, tier, visits: count } = expectedKanri(ctx, c);
    if (tier.known === true && tier.value === "none") {
      // 訪問診療料が 0 回の月は立てない
    } else if (facility.kyokagata) kanriOpen = true;
    else if (visits.some((v) => v.sameBuildingCount >= 2)) {
      unsupported.push({ code: "single_building_multi", detail: "同一建物に複数の患者がいる訪問があります。単一建物の人数別の管理料の点数は扱っていません" });
      kanriOpen = true;
    } else if (!family.known) {
      lack(`D03-residence:${input.yearMonth}`, "residence", kanriBlocks);
      kanriOpen = true;
    } else if (tier.known === false) {
      lack(`D03-tier:${input.yearMonth}`, tier.need, kanriBlocks);
      kanriOpen = true;
    } else if (tier.value !== "none") {
      const kubun = c.kanri.table[family.value][tier.value];
      // 使った入力：回数 2 以上なら重症か、重症でなければ注16
      const needs: NeedKey[] = ["comprehensiveCare", "residence", ...(count >= 2 ? (tier.value === "イ" ? (["table8_2"] as const) : (["table8_2", "facility.note16Met"] as const)) : [])];
      kanri = { kubun, tier: tier.value, date: visitDays[visitDays.length - 1] };
      add(kubun, [kanri.date], { derive: "D03", events: billedVisits, needs, tentative });
    }
  }
  if (kanri) {
    if ((c.hokatsu.tiers as string[]).includes(kanri.tier)) {
      if (!facts.careLevel.known) lack(`D04-careLevel:${input.yearMonth}`, "careLevel", [c.hokatsu.kubun]);
      else if (hokatsuEligible(ctx, c)) add(c.hokatsu.kubun, [kanri.date], { derive: "D04", events: billedVisits, needs: ["careLevel"], tentative });
    }
    if (ikouEligible(ctx, c)) add(c.ikou.kubun, [kanri.date], { derive: "D05", events: [...byDate(eventsOf(ctx, "discharge")), ...billedVisits], tentative });
  }

  // --- D06：在宅医療DX情報活用加算。月 1 回、最初の訪問診療料の日
  if (visitDays.length) {
    const dx = facility.dxTier;
    if (!dx.known) lack(`D06-dx:${input.yearMonth}`, "facility.dxTier", Object.values(c.dx.tiers));
    else if (dx.value !== "なし") add(c.dx.tiers[dx.value], [visitDays[0]], { derive: "D06", events: billedVisits.slice(0, 1), needs: ["facility.dxTier"] });
  }

  // --- D07・D08：ベースアップ評価料(Ⅰ)と物価対応料。訪問診療料を立てた日は訪問診療時の区分、往診料だけを立てた日は再診時等の区分。
  // 両方を立てた日は訪問診療時の区分だけ（再診時等を重ねない。L-32）。行を立てなかった日は数えない
  const oushinOnly = oushinOnlyBilledDays(ctx, c);
  const oushinOnlyEvents = billedOushins.filter((o) => oushinOnly.includes(o.date));
  if (visitDays.length || oushinOnly.length) {
    const bu = facility.baseUp;
    if (!bu.known) lack(`D07-baseUp:${input.yearMonth}`, "facility.baseUp", [...c.baseUp.visit, c.baseUp.revisit]);
    else if (bu.value === "注5") unsupported.push({ code: "baseup_note5", detail: "ベースアップ評価料(Ⅰ)の注5 の届出の区分は扱っていません" });
    else if (bu.value === "通常") {
      c.visitKubun.forEach((vk, i) => {
        const days = visitDays.filter((d) => visitKubunOn(ctx, c, d).includes(vk));
        add(c.baseUp.visit[i], days, { derive: "D07", events: billedVisits.filter((v) => days.includes(v.date)), needs: ["facility.baseUp"] });
      });
      add(c.baseUp.revisit, oushinOnly, { derive: "D07", events: oushinOnlyEvents, needs: ["facility.baseUp"] });
    }
    const pr = facility.priceResponse;
    if (!pr.known) lack(`D08-price:${input.yearMonth}`, "facility.priceResponse", [...c.price.visit, c.price.revisit]);
    else if (pr.value) {
      add(c.price.visit[0], visitDays, { derive: "D08", events: billedVisits, needs: ["facility.priceResponse"] });
      add(c.price.revisit, oushinOnly, { derive: "D08", events: oushinOnlyEvents, needs: ["facility.priceResponse"] });
    }
  }

  // --- D09：検体検査・血液採取・判断料。項目ごとに 1 回、検査の日ごとに血液採取 1 回、判断料は区分ごとに月 1 回（最初の検査の日）
  const tests = byDate(eventsOf(ctx, "test"));
  const items = new Map<string, EventRef[]>();
  const judgements = new Map<string, EventRef>();
  const drawn: EventRef[] = [];
  for (const t of tests) {
    for (const name of t.items) {
      const item = Object.hasOwn(c.testItems, name) ? c.testItems[name] : undefined;
      if (!item) {
        unsupported.push({ code: "unmapped_test_item", detail: name });
        continue;
      }
      items.set(item.kubun, [...(items.get(item.kubun) ?? []), t]);
      if (!judgements.has(item.judgement)) judgements.set(item.judgement, t);
      if (!drawn.some((e) => e.date === t.date)) drawn.push(t);
    }
  }
  add(c.tests.bloodDraw, drawn.map((e) => e.date), { derive: "D09", events: drawn });
  for (const [kubun, es] of items) add(kubun, es.map((e) => e.date), { derive: "D09", events: es });
  for (const k of c.tests.judgement) {
    const first = judgements.get(k);
    if (first) add(k, [first.date], { derive: "D09", events: [first] });
  }

  // --- D10：処方箋料。管理料を立てない月だけ（R05）。区分は R07 と同じ述語（月の処方に内服 7 種類以上があるか）で決める
  if (!kanri && !kanriOpen && rxs.length) add(rxManyOral(ctx, c) ? c.rx.many : c.rx.other, rxs.map((e) => e.date), { derive: "D10", events: rxs });

  // --- D11・D12：看取り加算・死亡診断加算・ターミナルケア加算は自動で立てない（FR-98）。本人が選んだときだけ行にする
  const death = byDate(eventsOf(ctx, "death"))[0];
  if (death) {
    const { mitori, shibou, terminal } = c.terminal;
    const id = `D11-mitori:${death.date}`;
    const picked = ask(id, "看取り加算と死亡診断加算は併せて算定できません。どちらを算定しますか", [
      { id: "mitori", label: "看取り加算", kubun: [mitori] },
      { id: "shibou", label: "死亡診断加算", kubun: [shibou] },
      { id: "none", label: "どちらも算定しない", kubun: [] },
    ], [mitori, shibou]);
    if (picked === "mitori" || picked === "shibou") add(picked === "mitori" ? mitori : shibou, [death.date], { derive: "D11", events: [death], choice: id });
    const enough = terminalVisitsOk(ctx, c);
    if (!facts.deathPlace.known) lack(`D12-place:${death.date}`, "deathPlace", [terminal]);
    else if (enough.ok === "unknown") {
      // 回数が、同じ日の訪問診療と往診が別々の診療かで変わる（X-73）。その日の事実不足（D01）に、ターミナルケア加算も待たせる
      for (const d of enough.ask) {
        const held = pending.find((p) => p.id === `D01-sameDay:${d}`);
        if (held) held.blocks.push(terminal);
        else lack(`D12-sameDay:${d}`, "sameDaySeparate", [terminal], d);
      }
    } else if (enough.ok) {
      const tid = `D12-terminal:${death.date}`;
      const yes = ask(tid, "在宅ターミナルケア加算を算定しますか（訪問の回数のほかの要件は、記録で確かめてください）", [
        { id: "yes", label: "算定する", kubun: [terminal] },
        { id: "no", label: "算定しない", kubun: [] },
      ], [terminal]);
      if (yes === "yes") add(terminal, [death.date], { derive: "D12", events: [death, ...visits, ...oushins].filter((e) => e.date <= death.date), needs: ["deathPlace"], choice: tid });
    }
  }

  return {
    revisionId: rev.id,
    lines: [...lines, ...input.manual],
    basis,
    pending,
    unsupported,
    totalStatus: pending.length || unsupported.length ? "withheld" : tentative ? "tentative" : "ok",
    staleChoices: Object.keys(input.choices).filter((id) => !asked.has(id)),
    notBilled,
  };
}
