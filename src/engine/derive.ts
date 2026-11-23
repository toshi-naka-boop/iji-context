// deriveLines(input, rev)：出来事と確かめた事実から、算定行を決定的に導出する（design.md §2-8。spec FR-94〜103）
// 決めるのは「どの区分を何回・どの日に立てるか」だけ。要件（背反・要件不足・週の限度など）は evaluate が判定する。
// 判定の述語は predicates.ts のものを検証（ルール）と共有する。LLM は使わない（src/mentor と LLM の SDK を import しない）
import { requiredComments, type RequiredComment } from "./comments";
import { targetOfNeed } from "./index";
import {
  baseUpDayKubun,
  billedVisitDays,
  buildingBandOf,
  expectedKanri,
  reducedOf,
  hokatsuEligible,
  ikouEligible,
  kanriKubun,
  kanriKubunOf,
  oushinOnlyBilledDays,
  rxKubunOn,
  sameDayOf,
  terminalVisitsOk,
  visitBillable,
  visitBillableNeed,
  visitKubunOn,
} from "./predicates";
import { resolveRevision } from "./revisions";
import type { Revision, RevisionConsts } from "./revisions/types";
import { addDays, eventsOf } from "./rules/util";
import { NOTE14_BANDS, type ClaimContext, type ClaimEvent, type ClaimLine, type Facility, type Facts, type NeedKey } from "./types";

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
  /**
   * 原請求の 10 人以上の管理料の注14 の側（claimNote14SideOf。design.md §15-4。round-57 X-172・round-58 C-333）。呼び出し側が、日で絞る前・導出する区分を外す前の請求の全部の行から求めて渡す。
   * 省くと「なし」（原請求がない導出）
   */
  claimNote14Side?: "減" | "通常" | "なし";
  /**
   * 原請求に 2 人以上の人数の区分の管理料の行があるか（claimMultiBandOf。round-61 X-200）。claimNote14Side と同じく、日で絞る前の請求の全部の行から求めて渡す。
   * 施設の申告 building が「ない」でも、真なら 1 人の区分を立てず保留にする（申告だけを根拠に点数の高い区分へ直さない。L-126）
   */
  claimMultiBand?: boolean;
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
  /** date は、日付ごとの事実（sameDaySeparate・sameDayOushinAfterVisit）の対象の日 */
  | {
      kind: "事実不足";
      id: string;
      need: NeedKey;
      target: "doctor" | "clerk";
      blocks: string[];
      date?: string;
      /** 事実がないのではなく決められない理由（段 17h）：note14_conflict＝申告（通常）と原請求（減の行）の食い違い（画面は R18.note14_conflict と同じ文）／note8＝注8 に当たるかを見ていないので減の行を 1 つに決められない／declaration_conflict＝申告（2 人以上の建物はない）と原請求（2 人以上の区分の行）の食い違い（画面は R19.declaration_conflict と同じ文。round-61 X-200） */
      reason?: "note14_conflict" | "note8" | "declaration_conflict";
    }
  | { kind: "要選択"; id: string; question: string; options: PendingOption[]; blocks: string[] };

/**
 * 導出の未対応。grade_not_in_revision は、その版に施設の種別の区分がない（比較用の版）。baseup_note5 は、注5 の区分の表を持たない版（比較用の版）。
 * 単一建物の人数別の管理料は段 17f で導出する（D03 が人数の区分を buildingBandOf で引く。design.md §15-4）
 */
export type Unsupported = { code: "grade_not_in_revision" | "baseup_note5" | "unmapped_test_item" | "rx_same_day_multi" | "terminal_requirement"; detail: string };

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
  notBilled: { event: EventRef; reason: "after_oushin" | "same_encounter" | "oushin_not_after_visit" }[];
  /** 行（導出した行と manual）に要る、摘要欄に書くこと（§11-13）。ready は値まで決まったもの、needsInput は医療事務が入れるもの */
  comments: RequiredComment[];
};

/**
 * 導出する区分のうち、R ルールが担当する区分（design.md §15-8 の g11Owned の表。D01〜D08・D11・D12）。
 * 算定プレビューでは G11 が見ない（導出がカルテの出来事から立てた行なので、2 回言わない。C-230）。版の定数（種別の表・注5 の表）から作り、手で並べない
 */
export function g11Owned(c: RevisionConsts): string[] {
  const baseUp = baseUpDayKubun(c);
  return [
    ...c.visitKubun,
    c.oushin.kubun,
    c.oushin.revisit,
    ...Object.values(c.oushin.kinkyu),
    ...kanriKubun(c),
    c.hokatsu.kubun,
    c.ikou.kubun,
    ...Object.values(c.dx.tiers),
    ...baseUp.visit,
    ...baseUp.revisit,
    ...c.price.visit,
    c.price.revisit,
    c.terminal.mitori,
    c.terminal.shibou,
    ...Object.values(c.terminal.terminal),
  ];
}

/**
 * g11Owned の区分ごとの担当のルール（design.md §15-8 の表）。取り込んだ請求の G11 の手順 3 で、候補の区分の担当のルールを R18 と一緒に 1 回掛けるのに使う。
 * 行は表の行ごと（g11Owned と同じ版の定数から作る。表の区分を全部覆うことをテストで縛る）
 */
export function g11Owners(c: RevisionConsts): { kubun: string[]; rules: string[] }[] {
  const baseUp = baseUpDayKubun(c);
  return [
    { kubun: [...c.visitKubun], rules: ["R01", "R10", "R13"] },
    { kubun: [c.oushin.kubun, c.oushin.revisit, ...Object.values(c.oushin.kinkyu)], rules: ["R10", "R18"] },
    { kubun: kanriKubun(c), rules: ["R01", "R02", "R16", "R18"] },
    { kubun: [c.hokatsu.kubun, c.ikou.kubun], rules: ["R03", "R14"] },
    { kubun: Object.values(c.dx.tiers), rules: ["R12"] },
    { kubun: [...baseUp.visit, ...baseUp.revisit], rules: ["R08", "R18"] },
    { kubun: [...c.price.visit, c.price.revisit], rules: ["R15"] },
    { kubun: [c.terminal.mitori, c.terminal.shibou, ...Object.values(c.terminal.terminal)], rules: ["R09", "R18"] },
  ];
}

/**
 * 導出する区分（版の定数から決まる）。これ以外の区分は manual で入力どおりに通す。
 * g11Owned と、行為の結果として要る区分（検体検査の項目・血液採取・判断料〔D09〕と処方箋料〔D10〕。どちらの経路でも G11 が見る）
 */
export function derivedKubun(c: RevisionConsts): string[] {
  return [...g11Owned(c), c.tests.bloodDraw, ...Object.values(c.testItems).map((t) => t.kubun), ...c.tests.judgement, c.rx.many, c.rx.other];
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
  const ctx: ClaimContext = { claimId: "", yearMonth: input.yearMonth, facility, payer: "国保連", prefecture: facility.prefecture, facts, events: input.events, recordsKnown: true, commentsKnown: false, lines, history: input.history };

  const ref = (e: EventRef): EventRef => ({ type: e.type, date: e.date });
  /** その版の点数表にある区分か。版で有無が変わる導出（物価対応料など）は、これで決める（版の id では分けない。design.md §11-2） */
  const has = (kubun: string) => Object.hasOwn(rev.points, kubun);
  function add(kubun: string, dates: string[], b: { derive: string; events: EventRef[]; needs?: NeedKey[]; choice?: string; tentative?: boolean }) {
    if (dates.length === 0 || !has(kubun)) return;
    const sorted = [...dates].sort();
    lines.push({ kubun, count: sorted.length, dates: sorted });
    basis.push({ kubun, dates: sorted, derive: b.derive, events: b.events.map(ref), needs: b.needs ?? [], ...(b.choice ? { choice: b.choice } : {}), tentative: b.tentative ?? false });
  }
  const lack = (id: string, need: NeedKey, blocks: string[], date?: string, reason?: "note14_conflict" | "note8" | "declaration_conflict") => pending.push({ kind: "事実不足", id, need, target: targetOfNeed(need), blocks, ...(date ? { date } : {}), ...(reason ? { reason } : {}) });
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
  const baseUpDay = baseUpDayKubun(c);
  const dayBlocks = [...baseUpDay.visit, ...baseUpDay.revisit, ...c.price.visit, c.price.revisit].filter(has);
  const grade = facility.grade;
  /** 施設の種別で引く加算の区分（種別が分からなければ undefined。その版にその種別の区分がなければ null） */
  const byGradeOf = (t: Partial<Record<string, string>>): string | null | undefined => (!grade.known ? undefined : (t[grade.value] ?? null));
  const noGradeKubun = (what: string) => unsupported.push({ code: "grade_not_in_revision", detail: `この版は、施設の種別（${grade.known ? grade.value : ""}）の${what}の区分を持っていないので、行にしていません` });

  // --- D01・D02：訪問診療料と往診料（§2-3-4・§11-5）。同じ日の両方は、出来事だけでは立てない。関係は R10 と同じ述語（sameDayOf）で決める
  const sameDay = new Map<string, { visit: Decision | "check"; oushin: Decision }>();
  for (const d of [...new Set(visits.map((v) => v.date))].filter((x) => oushins.some((o) => o.date === x))) {
    const visitK = [...new Set(visits.filter((v) => v.date === d).map(visitKubunOf))];
    const blocks = [...visitK, c.oushin.kubun, ...dayBlocks, ...kanriBlocks];
    const s = sameDayOf(ctx, d);
    if (s.known === false) {
      lack(`D01-sameDay:${d}`, s.need, blocks, d);
      sameDay.set(d, { visit: "hold", oushin: "hold" });
    } else if (s.value === "same") {
      const id = `D01-encounter:${d}`;
      const picked = ask(id, "同じ日の訪問診療と往診は 1 回の診療です。診療の中身に合うほうを選んでください", [
        { id: "visit", label: "訪問診療料（定期の訪問診療）", kubun: visitK },
        { id: "oushin", label: "往診料（求めに応じた往診）", kubun: [c.oushin.kubun] },
      ], blocks);
      sameDay.set(d, picked === undefined ? { visit: "hold", oushin: "hold" } : picked === "visit" ? { visit: "bill", oushin: "skip" } : { visit: "skip", oushin: "bill" });
      if (picked === "visit") for (const o of oushins.filter((x) => x.date === d)) notBilled.push({ event: ref(o), reason: "same_encounter" });
      if (picked === "oushin") for (const v of visits.filter((x) => x.date === d)) notBilled.push({ event: ref(v), reason: "same_encounter" });
    } else if (s.value === "after") sameDay.set(d, { visit: "check", oushin: "bill" });
    else {
      // 別々の診療だが、訪問診療のあとの往診ではない：往診料は立てない。往診料を立てない日なので、訪問診療料に同じ日の制限は掛からない
      sameDay.set(d, { visit: "bill", oushin: "skip" });
      for (const o of oushins.filter((x) => x.date === d)) notBilled.push({ event: ref(o), reason: "oushin_not_after_visit" });
    }
  }
  const oushinDecision = (date: string): Decision => sameDay.get(date)?.oushin ?? "bill";
  /** 訪問診療料を立てるか。往診料を立てる同じ日（訪問診療のあとの往診）・往診の翌日は、制限の判定（visitBillable。R10 と共有）で決める */
  function visitDecision(v: (typeof visits)[number]): Decision {
    const same = sameDay.get(v.date);
    // 同じ日の要選択で訪問診療料を選んだ日（bill）も、前日の往診料の制限は下で調べる（X-74）
    if (same && (same.visit === "hold" || same.visit === "skip")) return same.visit;
    const prev = addDays(v.date, -1);
    const afterOushin = same?.visit === "check" || (oushins.some((o) => o.date === prev) && oushinDecision(prev) !== "skip");
    if (!afterOushin) return "bill";
    const ok = visitBillable(ctx);
    if (ok === true) return "bill";
    if (ok === "unknown") {
      lack(`D01-doc:${v.date}`, visitBillableNeed(ctx), [visitKubunOf(v), ...dayBlocks, ...kanriBlocks], v.date);
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
    add(k, mine.map((v) => v.date), { derive: "D01", events: mine, needs: sameDay.size ? ["sameDaySeparate", "sameDayOushinAfterVisit"] : [] });
  }
  const billedOushins = oushins.filter((o) => oushinDecision(o.date) === "bill");
  add(c.oushin.kubun, billedOushins.map((o) => o.date), { derive: "D02", events: billedOushins });
  // 往診料と併せて再診料（留意 C001 (11)。L-40 の推奨案）。訪問診療料も立てた日には重ねない（算定を増やさない側）
  const visitDaySet = new Set(billedVisits.map((v) => v.date));
  const revisitOushins = billedOushins.filter((o) => !visitDaySet.has(o.date));
  add(c.oushin.revisit, revisitOushins.map((o) => o.date), { derive: "D02", events: revisitOushins });
  const emergencies = billedOushins.filter((o) => o.kind === "emergency");
  if (emergencies.length) {
    // 緊急往診加算は施設の種別で区分が分かれる（design.md §15-4）。「定める患者以外」の区分は版にないので、対象患者のときだけ立てる
    const kinkyuAll = Object.values(c.oushin.kinkyu);
    const kinkyu = byGradeOf(c.oushin.kinkyu);
    if (!facts.emergencyEligible.known) lack(`D02-kinkyu:${input.yearMonth}`, "emergencyEligible", kinkyuAll);
    else if (facts.emergencyEligible.value) {
      if (kinkyu === undefined) lack(`D02-grade:${input.yearMonth}`, "facility.grade", kinkyuAll);
      else if (kinkyu === null) noGradeKubun("緊急往診加算");
      else add(kinkyu, emergencies.map((o) => o.date), { derive: "D02", events: emergencies, needs: ["emergencyEligible", "facility.grade"] });
    }
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
    } else if (!grade.known) {
      // 施設の種別が分からないと、管理料の区分（族×種別×区分）が決まらない（design.md §15-4）
      lack(`D03-grade:${input.yearMonth}`, "facility.grade", kanriBlocks);
      kanriOpen = true;
    } else if (!family.known) {
      lack(`D03-residence:${input.yearMonth}`, "residence", kanriBlocks);
      kanriOpen = true;
    } else if (tier.known === false) {
      lack(`D03-tier:${input.yearMonth}`, tier.need, kanriBlocks);
      kanriOpen = true;
    } else if (tier.value !== "none") {
      // 単一建物の人数の区分（design.md §15-4）：施設の申告 building が「ない」なら 1 人。ほかは患者ごとの事実。分からなければ保留
      const band = buildingBandOf(ctx);
      const normal = band.known ? kanriKubunOf(c, family.value, grade.value, tier.value, band.value) : undefined;
      // 10 人以上の区分（段 17h）：注14 の申告で、減算 → 減の行、通常 → 通常の行、分からない → 保留。版に減の行がなければ通常の行
      const tenPlus = band.known && NOTE14_BANDS.includes(band.value) && normal !== undefined && c.kanri.note14Pairs !== undefined;
      const note14 = facility.note14;
      const reds = tenPlus ? reducedOf(c, normal!) : [];
      let kubun = normal;
      if (!band.known) {
        lack(`D03-band:${input.yearMonth}`, "buildingBand", kanriBlocks);
        kanriOpen = true;
      } else if (facility.building.known && facility.building.value === "none" && input.claimMultiBand) {
        // 申告（2 人以上の建物はない）と原請求（2 人以上の区分の行）の食い違い：申告だけを根拠に 1 人の区分（点数の高い側）を立てない（round-61 X-200。L-126）。
        // 原請求が減の行で申告が通常なら、その食い違いも残す（プレビューで R18.note14_conflict が消えないように）
        lack(`D03-building:${input.yearMonth}`, "facility.building", kanriBlocks, undefined, "declaration_conflict");
        if (note14.known && note14.value === "通常" && input.claimNote14Side === "減") lack(`D03-note14:${input.yearMonth}`, "facility.note14", kanriBlocks, undefined, "note14_conflict");
        kanriOpen = true;
      } else if (tenPlus && !note14.known) {
        lack(`D03-note14:${input.yearMonth}`, "facility.note14", kanriBlocks);
        kanriOpen = true;
      } else if (tenPlus && note14.known && note14.value === "通常" && input.claimNote14Side === "減") {
        // 申告（通常）と原請求（減の行）の食い違い：申告だけを根拠に点数の高い通常の行を立てない（round-57 X-172。L-130）
        lack(`D03-note14:${input.yearMonth}`, "facility.note14", kanriBlocks, undefined, "note14_conflict");
        kanriOpen = true;
      } else if (tenPlus && note14.known && note14.value === "減算" && reds.length !== 1) {
        // 在支診以外の区分では減の行が 2 つ（注14 だけ・注8 と重ねた行）。注8 に当たるかを持たないので立てない（round-57 X-171。L-151）
        lack(`D03-note8:${input.yearMonth}`, "facility.note14", kanriBlocks, undefined, "note8");
        kanriOpen = true;
      } else if ((kubun = tenPlus && note14.known && note14.value === "減算" ? reds[0] : normal) === undefined) {
        noGradeKubun("管理料");
        kanriOpen = true;
      } else {
        // 使った入力：施設の種別と、回数 2 以上なら重症か、重症でなければ注16
        const needs: NeedKey[] = ["comprehensiveCare", "residence", "facility.grade", facility.building.known && facility.building.value === "none" ? "facility.building" : "buildingBand", ...(tenPlus ? (["facility.note14"] as const) : []), ...(count >= 2 ? (tier.value === "イ" || !c.kanri.note16.enabled ? (["table8_2"] as const) : (["table8_2", "facility.note16Met"] as const)) : [])];
        kanri = { kubun, tier: tier.value, date: visitDays[visitDays.length - 1] };
        add(kubun, [kanri.date], { derive: "D03", events: billedVisits, needs, tentative });
      }
    }
  }
  if (kanri) {
    if ((c.hokatsu.tiers as string[]).includes(kanri.tier)) {
      const e = hokatsuEligible(ctx, c);
      if (e.known === false) lack(`D04-${e.need}:${input.yearMonth}`, e.need, [c.hokatsu.kubun]);
      else if (e.value) add(c.hokatsu.kubun, [kanri.date], { derive: "D04", events: billedVisits, needs: (["careLevel", "disabilitySupportLevel", "table8_3Other"] as const).filter((k) => facts[k].known), tentative });
    }
    if (ikouEligible(ctx, c)) add(c.ikou.kubun, [kanri.date], { derive: "D05", events: [...byDate(eventsOf(ctx, "discharge")), ...billedVisits], tentative });
  }

  // --- D06：在宅医療DX情報活用加算。月 1 回、最初の訪問診療料の日
  if (visitDays.length && Object.values(c.dx.tiers).some(has)) {
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
    const note5 = c.baseUp.note5;
    if (![...c.baseUp.visit, c.baseUp.revisit].some(has)) {
      // この版にベースアップ評価料(Ⅰ)の区分がない：施設の設定を聞かない
    } else if (!bu.known) lack(`D07-baseUp:${input.yearMonth}`, "facility.baseUp", [...baseUpDay.visit, ...baseUpDay.revisit].filter(has));
    else if (bu.value === "注5" && !note5) unsupported.push({ code: "baseup_note5", detail: "この版は、ベースアップ評価料(Ⅰ)の注5 の区分を持っていないので、行にしていません" });
    else if (bu.value !== "なし") {
      // 注5 の届出のある施設は、同じ区分の注5 の区分で立てる（design.md §15-4。X-133）
      const kubunOf = (k: string) => (bu.value === "注5" ? note5![k] : k);
      c.visitKubun.forEach((vk, i) => {
        const days = visitDays.filter((d) => visitKubunOn(ctx, c, d).includes(vk));
        add(kubunOf(c.baseUp.visit[i]), days, { derive: "D07", events: billedVisits.filter((v) => days.includes(v.date)), needs: ["facility.baseUp"] });
      });
      add(kubunOf(c.baseUp.revisit), oushinOnly, { derive: "D07", events: oushinOnlyEvents, needs: ["facility.baseUp"] });
    }
    const pr = facility.priceResponse;
    if (![...c.price.visit, c.price.revisit].some(has)) {
      // この版に物価対応料の区分がない：施設の設定を聞かない
    } else if (!pr.known) lack(`D08-price:${input.yearMonth}`, "facility.priceResponse", [...c.price.visit, c.price.revisit]);
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

  // --- D10：処方箋料。管理料を立てない月だけ（R05）。区分は処方ごとに、R07 と同じ述語（rxKubunOn）で決める（X-77・§11-5）
  if (!kanri && !kanriOpen) {
    const rxOf = new Map<string, { events: typeof rxs; asked: boolean }>([c.rx.other, c.rx.many].map((k) => [k, { events: [], asked: false }]));
    for (const d of [...new Set(rxs.map((e) => e.date))]) {
      const e = rxKubunOn(ctx, c, d);
      if (e.known === true) {
        const of = rxOf.get(e.kubun)!;
        const event = rxs.find((x) => x.date === d)!;
        of.events.push(event);
        // 長期処方かの答えを使ったのは、種類数で決まらず、対象の薬が含まれないとも分かっていない処方
        if (e.why !== "many" && event.psychotropic !== false) of.asked = true;
      } else if (e.need === "rxLongPsychotropic") lack(`D10-long:${d}`, "rxLongPsychotropic", [c.rx.many, c.rx.other], d);
      // 同じ日に処方が 2 回以上：日付ごとの事実では処方を分けられないので、その日は立てない
      else unsupported.push({ code: "rx_same_day_multi", detail: `同じ日に 2 回以上の処方がある日の処方箋料は扱っていません（${d}）` });
    }
    for (const [k, of] of rxOf) add(k, of.events.map((e) => e.date), { derive: "D10", events: of.events, needs: of.asked ? ["rxLongPsychotropic"] : [] });
  }

  // --- D11・D12：看取り加算・死亡診断加算・ターミナルケア加算は自動で立てない（FR-98）。本人が選んだときだけ行にする
  const death = byDate(eventsOf(ctx, "death"))[0];
  if (death) {
    const { mitori, shibou } = c.terminal;
    // 在宅ターミナルケア加算は施設の種別で区分が分かれる（design.md §15-4）。保留が待たせるのは種別の区分で、種別が分からない間は全部の種別の区分
    const terminalKubun = byGradeOf(c.terminal.terminal);
    const terminalAll = terminalKubun ? [terminalKubun] : Object.values(c.terminal.terminal);
    const id = `D11-mitori:${death.date}`;
    const picked = ask(id, "看取り加算と死亡診断加算は併せて算定できません。どちらを算定しますか", [
      { id: "mitori", label: "看取り加算", kubun: [mitori] },
      { id: "shibou", label: "死亡診断加算", kubun: [shibou] },
      { id: "none", label: "どちらも算定しない", kubun: [] },
    ], [mitori, shibou]);
    if (picked === "mitori" || picked === "shibou") add(picked === "mitori" ? mitori : shibou, [death.date], { derive: "D11", events: [death], choice: id });
    // 回数の要件を持たない版では、ターミナルケア加算を導出しない（合計は出さない）
    const enough = c.terminal.days === undefined || c.terminal.minVisits === undefined ? null : terminalVisitsOk(ctx, c);
    if (enough === null) unsupported.push({ code: "terminal_requirement", detail: "この版は、在宅ターミナルケア加算の訪問の回数の要件を持っていないので、行にしていません" });
    else if (!facts.deathPlace.known) lack(`D12-place:${death.date}`, "deathPlace", terminalAll);
    else if (enough.ok === "unknown") {
      // 回数が、同じ日の訪問診療と往診が別々の診療かで変わる（X-73）。その日の事実不足（D01）に、ターミナルケア加算も待たせる
      for (const d of enough.ask) {
        const held = pending.find((p) => p.id === `D01-sameDay:${d}`);
        if (held) held.blocks.push(...terminalAll);
        else lack(`D12-sameDay:${d}`, "sameDaySeparate", terminalAll, d);
      }
      // 回数が足りず、訪問診療はある：退院時共同指導料1 を算定していれば満たす（R09 と同じ述語）
      if (enough.askGuidance) lack(`D12-guidance:${death.date}`, "dischargeJointGuidance", terminalAll);
    } else if (enough.ok && terminalKubun === undefined) lack(`D12-grade:${death.date}`, "facility.grade", terminalAll);
    else if (enough.ok && terminalKubun === null) noGradeKubun("在宅ターミナルケア加算");
    else if (enough.ok && terminalKubun) {
      const terminal = terminalKubun;
      const tid = `D12-terminal:${death.date}`;
      const yes = ask(tid, "在宅ターミナルケア加算を算定しますか（訪問の回数のほかの要件は、記録で確かめてください）", [
        { id: "yes", label: "算定する", kubun: [terminal] },
        { id: "no", label: "算定しない", kubun: [] },
      ], [terminal]);
      if (yes === "yes") add(terminal, [death.date], { derive: "D12", events: [death, ...visits, ...oushins].filter((e) => e.date <= death.date), needs: ["deathPlace", "facility.grade"], choice: tid });
    }
  }

  const all = [...lines, ...input.manual];
  return {
    revisionId: rev.id,
    lines: all,
    basis,
    pending,
    unsupported,
    totalStatus: pending.length || unsupported.length ? "withheld" : tentative ? "tentative" : "ok",
    staleChoices: Object.keys(input.choices).filter((id) => !asked.has(id)),
    notBilled,
    comments: requiredComments({ ...ctx, lines: all }, rev),
  };
}
