// 介護保険との調整（R20）・ほかの医療機関との調整（R21）の判定と、点検の範囲の「見ていません」（design.md §18-3・§18-4・§18-6。v37 21c）。
// 判定の決まりは EM §2-13 の行（R8-248〜R8-251・R8-254〜R8-256・R8-265・R8-270・R8-274・R8-275・R8-284）だけを引く。LLM には判定させない。
// 指摘はすべて条件つき（params.conditional = "1"）で、文は前提（申告と、確かめた日・出どころ）から始まる。機関名・施設名は扱わない（判断 L）
import type { Basis, ShortStayUse } from "./care";
import { kanriLines } from "./predicates";
import { addDays } from "./rules/util";
import type { RevisionConsts } from "./revisions/types";
import type { ClaimContext, Finding, FindingKind } from "./types";

export const R20_REFERENCE = "医療保険と介護保険の給付調整（EM §2-13 R8-248〜R8-251・R8-254〜R8-256・R8-265）";
export const R21_REFERENCE = "ほかの医療機関との調整（EM §2-13 R8-270・R8-274・R8-275・R8-284）";

/** 点検の範囲の文（design.md §18-6） */
export const CARE_SCOPE_TEXT = {
  scenes:
    "最初の版で見ている場面：特養の入所者の訪問診療・短期入所の月・老健・介護医療院の入所者の訪問診療と管理料・小多機の宿泊の月の管理料・要介護者の在宅患者連携指導料・在医総管は 1 機関・求めによる訪問診療料・特別の関係の訪問看護の月の指示料",
  careUnknown: "介護保険との調整は見ていません（申告がない・分からない項目がある）",
  othersUnknown: "ほかの機関との調整は見ていません（申告がない）",
  midMonth: "月の途中で住まいが変わっています（日ごとには見ていません）",
  yougo: "養護老人ホーム（定員 110 名を超える）の入所者は、在医総管・施医総管を見ていません",
  priorUnknown: "利用前 30 日の当院の訪問が分からないので見ていません",
  stayKanri: "短期入所の月の管理料は、日ごとに決められないので見ていません",
  mitori: "看取り介護加算の施設の入所者は、看取りの 30 日に当たるかを見ていません",
  split: "読みが割れます（特養等の通知 4 と給付調整の通知 別紙１ ※10）。厚生局への照会の候補です",
  noReferrer: "求めた機関の申告がありません（他の医療機関の求めによる訪問診療料(Ⅰ)2 は見ていません）",
} as const;

type Out = { findings: Finding[]; notes: Set<string> };

const fmtDays = (days: string[]) => days.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join("・");

/** 前提の文：「申告（…・確かめた日 出どころ）のとおりなら」。確かめた日が古ければ「確かめてから n か月を過ぎています」を足す */
export function premiseOf(what: string, b: Basis, extra = ""): string {
  return `申告（${what}・${b.checkedOn} ${b.source}${b.staleMonths ? `。確かめてから ${b.staleMonths} か月を過ぎています` : ""}）のとおりなら${extra}`;
}

function conditional(ruleId: "R20" | "R21", kind: FindingKind, lineRefs: string[], key: string, params: Record<string, string>, days?: string[]): Finding {
  return { ruleId, kind, lineRefs, messageKey: `${ruleId}.${key}`, params: { ...params, conditional: "1" }, reference: ruleId === "R20" ? R20_REFERENCE : R21_REFERENCE, ...(days && days.length ? { days } : {}) };
}

/** 訪問診療料の行（(Ⅰ)1・(Ⅰ)2）と、その算定日 */
function visitsOf(ctx: ClaimContext, c: RevisionConsts) {
  const kubun = new Set([...c.visitKubun, ...(c.visit2Kubun ?? [])]);
  const lines = ctx.lines.filter((l) => l.count > 0 && kubun.has(l.kubun));
  return { lines, dates: [...new Set(lines.flatMap((l) => l.dates))].sort() };
}

/** R20 の場面の区分の行があるか（点検の範囲と聞き取りの対象に使う） */
export function hasCareScene(ctx: ClaimContext, c: RevisionConsts): boolean {
  if (!c.care) return false;
  return visitsOf(ctx, c).lines.length > 0 || kanriLines(ctx, c).length > 0 || ctx.lines.some((l) => l.count > 0 && l.kubun === c.care!.renkei);
}
/** R21 の場面の区分の行があるか */
export function hasOthersScene(ctx: ClaimContext, c: RevisionConsts): boolean {
  if (!c.care) return false;
  const k = new Set([...(c.visit2Kubun ?? []), c.care.shiji]);
  return kanriLines(ctx, c).length > 0 || ctx.lines.some((l) => l.count > 0 && k.has(l.kubun));
}

const terminalOf = (ctx: ClaimContext) => ctx.facts.terminalCancer ?? { known: false as const };
/** 末期の悪性腫瘍か分からないときに、前提に足す句（design.md §18-12 の 2。「末期ではない」と黙って読まない） */
const NOT_TERMINAL = "、末期の悪性腫瘍でなければ";
const withNotTerminal = (f: Finding): Finding => ({ ...f, params: { ...f.params, premise: `${f.params!.premise}${NOT_TERMINAL}` } });
const askDoctor = (ruleId: "R20", lineRefs: string[]): Finding => ({ ruleId, kind: "情報不足", lineRefs, missing: { target: "doctor", field: "terminalCancer" }, messageKey: `${ruleId}.missing_fact`, reference: R20_REFERENCE });

/** R20（介護）。design.md §18-3 の ①②④ */
export function judgeCare(ctx: ClaimContext, c: RevisionConsts): Out {
  const out: Out = { findings: [], notes: new Set() };
  if (!c.care || !hasCareScene(ctx, c)) return out;
  const care = ctx.care;
  const visits = visitsOf(ctx, c);
  const kanri = kanriLines(ctx, c);
  const renkei = ctx.lines.filter((l) => l.count > 0 && l.kubun === c.care!.renkei);
  const res = care?.residence;
  const terminal = terminalOf(ctx);

  // ④ 要介護・要支援の患者の在宅患者連携指導料（R8-265）
  if (renkei.length > 0) {
    const cert = care?.certified;
    if (!cert || !cert.known) out.notes.add(CARE_SCOPE_TEXT.careUnknown);
    else if (cert.value) out.findings.push(conditional("R20", "要件不足", [c.care.renkei], "renkei", { premise: premiseOf("要介護・要支援の認定あり", { checkedOn: cert.checkedOn, source: cert.source as Basis["source"] }) }));
  }
  if (visits.lines.length === 0 && kanri.length === 0) return out;

  // 住まいの種別の申告がない・分からない：① と ② の老健・介護医療院の側は見ない
  if (!res || res.type === "分からない") {
    out.notes.add(CARE_SCOPE_TEXT.careUnknown);
    return out;
  }
  // 月の途中で住まいが変わった月は判定しない（C-511）
  if (res.changedMidMonth) {
    out.notes.add(CARE_SCOPE_TEXT.midMonth);
    return out;
  }
  if (res.type === "養護老人ホーム（それ以外）" && kanri.length > 0) out.notes.add(CARE_SCOPE_TEXT.yougo);

  // ① 特養の入所者（R8-249・R8-255）
  if (res.type === "特養（地域密着型を含む）") {
    const shisetsu = kanri.filter((l) => l.family === "施設総管").map((l) => l.kubun);
    const refs = [...new Set([...visits.lines.map((l) => l.kubun), ...shisetsu])];
    if (refs.length > 0 && !(terminal.known && terminal.value)) {
      const mitori = res.home?.mitoriFacility ?? "分からない";
      if (mitori === "はい") out.notes.add(CARE_SCOPE_TEXT.mitori);
      else if (mitori === "分からない") out.notes.add(CARE_SCOPE_TEXT.careUnknown);
      else {
        const f = conditional("R20", "要件不足", refs, "tokuyou", { premise: premiseOf("特養に入所・入所先は看取り介護加算の施設基準に合わない", res) });
        out.findings.push(terminal.known ? f : withNotTerminal(f));
        if (!terminal.known) out.findings.push(askDoctor("R20", refs));
      }
    }
  }

  // ② 老健・介護医療院の入所者（R8-251）
  if (res.type === "老健" || res.type === "介護医療院") {
    const refs = [...new Set([...visits.lines.map((l) => l.kubun), ...kanri.map((l) => l.kubun)])];
    if (refs.length > 0) out.findings.push(conditional("R20", "要件不足", refs, "rouken", { premise: premiseOf(`${res.type}に入所`, res) }));
    return out;
  }

  // ② 短期入所の月（R8-248・R8-250・R8-251・R8-254・R8-256）
  const stay = care?.shortStay;
  if (!stay || stay.status === "分からない") {
    out.notes.add(CARE_SCOPE_TEXT.careUnknown);
    return out;
  }
  if (stay.status !== "使った") return out;
  // 2 回以上で、どれかの期間の日付がない月は判定しない（X-362）
  if (stay.uses.length >= 2 && stay.uses.some((u) => u.start === null || u.end === null)) {
    out.notes.add(CARE_SCOPE_TEXT.careUnknown);
    return out;
  }
  const stayBasis: Basis = { checkedOn: stay.checkedOn ?? "", source: stay.source ?? "その他", ...(stay.staleMonths ? { staleMonths: stay.staleMonths } : {}) };
  for (const u of stay.uses) {
    const before = out.findings.length;
    judgeStay(ctx, c, u, stayBasis, visits, kanri, out);
    // 末期の悪性腫瘍か分からないとき（design.md §18-12 の 2）：答えが末期で変わる指摘（短期入所生活介護は全部、宿泊は利用開始後 30 日）に前提を足し、医師に聞く。① と同じ
    if (terminalOf(ctx).known) continue;
    const touched = out.findings.slice(before).filter((f) => u.kind === "短期入所生活介護" || f.messageKey.endsWith("_30"));
    if (touched.length === 0) continue;
    out.findings = out.findings.map((f, i) => (i >= before && touched.includes(f) ? withNotTerminal(f) : f));
    if (!out.findings.some((f) => f.missing?.field === "terminalCancer")) out.findings.push(askDoctor("R20", [...new Set(touched.flatMap((f) => f.lineRefs))]));
  }
  return out;
}

type Visits = ReturnType<typeof visitsOf>;
type Kanri = ReturnType<typeof kanriLines>;

/** 短期入所・宿泊の利用 1 つ */
function judgeStay(ctx: ClaimContext, c: RevisionConsts, u: ShortStayUse, b: Basis, visits: Visits, kanri: Kanri, out: Out) {
  const cc = c.care!;
  const dated = u.start !== null && u.end !== null;
  const inStay = (d: string) => dated && d >= u.start! && d <= u.end!;
  // 期間の中の算定日（日付がなければ、全部の算定日を「期間に行った分があれば」の前提で）
  const days = dated ? visits.dates.filter(inStay) : visits.dates;
  const visitRefs = visits.lines.filter((l) => !dated || l.dates.some(inStay)).map((l) => l.kubun);
  // 月 1 回の管理料は、その月の訪問診療料の算定日がすべて期間に入るときだけ判定する（C-492）
  const allIn = dated && visits.dates.length > 0 && visits.dates.every(inStay);
  const what = `${u.kind}を利用${dated ? `（${fmtDays([u.start!, u.end!]).replace("・", "〜")}）` : ""}`;
  const premise = premiseOf(what, b, dated ? "" : "、短期入所の期間に行った分があれば");
  const dayText = { days: fmtDays(days) };
  const kanriJudged = () => {
    if (kanri.length > 0 && !allIn) out.notes.add(CARE_SCOPE_TEXT.stayKanri);
    return kanri.length > 0 && allIn;
  };
  const terminal = terminalOf(ctx);

  // 短期入所療養介護（老健・病院・診療所）：訪問診療料・在医総管・施医総管は算定できない（R8-251）
  if (u.kind === "短期入所療養介護（老健）" || u.kind === "短期入所療養介護（病院・診療所）") {
    if (visitRefs.length > 0 && days.length > 0) out.findings.push(conditional("R20", "要件不足", visitRefs, "ryouyou_visit", { premise, ...dayText }, days));
    if (kanriJudged()) out.findings.push(conditional("R20", "要件不足", kanri.map((l) => l.kubun), "ryouyou_kanri", { premise }));
    return;
  }

  const seikatsu = u.kind === "短期入所生活介護";
  const side = seikatsu ? "seikatsu" : "shoutaki";
  // 末期の悪性腫瘍の患者と、退院日から利用を始めた患者（短期入所生活介護）は、資料で読みが割れるので判定しない（U-57）
  if (seikatsu && ((terminal.known && terminal.value) || u.fromDischarge === "はい")) {
    out.notes.add(CARE_SCOPE_TEXT.split);
    return;
  }
  // 族（R8-256：生活介護は施医総管で、R8-254：宿泊は在医総管で）。宿泊は、2 値が施設入居等の患者だけ（自宅の患者は R16 が確定で見る。C-501）
  const res = ctx.facts.residence;
  const wrongFamily = seikatsu ? kanri.filter((l) => l.family === "在医総管") : res.known && res.value === "施設入居等" ? kanri.filter((l) => l.family === "施設総管") : [];
  const judged = kanriJudged();
  if (judged && wrongFamily.length > 0) out.findings.push(conditional("R20", "区分誤り", wrongFamily.map((l) => l.kubun), `${side}_family`, { premise }));
  // 配置医師（施設の医師）を除く（R8-248・R8-250・R8-256）。「はい」のときだけ（分からない・施設を付けていないときは、この向きでは指摘しない。X-352・X-363）
  if (u.home?.placedPhysician === "はい") {
    const p = premiseOf(`${what}・当院の医師は利用先の施設の医師`, b, dated ? "" : "、短期入所の期間に行った分があれば");
    if (visitRefs.length > 0 && days.length > 0) out.findings.push(conditional("R20", "要件不足", visitRefs, `${side}_haichi_visit`, { premise: p, ...dayText }, days));
    const target = seikatsu ? kanri.filter((l) => l.family === "施設総管") : kanri.filter((l) => l.family === "在医総管");
    if (judged && target.length > 0) out.findings.push(conditional("R20", "要件不足", target.map((l) => l.kubun), `${side}_haichi_kanri`, { premise: p }));
    return;
  }
  // 利用前 30 日以内の当院の算定（R8-248・R8-250）。宿泊で退院日から始めた（はい）なら、この条件を外す（X-364）
  const priorNeeded = seikatsu || u.fromDischarge !== "はい";
  if (priorNeeded) {
    if (u.priorVisit === null) out.notes.add(CARE_SCOPE_TEXT.priorUnknown);
    else if (u.priorVisit === false) {
      // 宿泊で、退院日から始めたかが分からないときは、指摘を出さず「見ていません」（X-353）
      if (!seikatsu && u.fromDischarge === "分からない") out.notes.add(CARE_SCOPE_TEXT.careUnknown);
      else {
        const p = premiseOf(`${what}・利用前 30 日に当院の訪問診療料等の算定なし`, b, dated ? "" : "、短期入所の期間に行った分があれば");
        if (visitRefs.length > 0 && days.length > 0) out.findings.push(conditional("R20", "要件不足", visitRefs, `${side}_prior_visit`, { premise: p, ...dayText }, days));
        const target = seikatsu ? kanri.filter((l) => l.family === "施設総管") : kanri.filter((l) => l.family === "在医総管");
        if (judged && target.length > 0) out.findings.push(conditional("R20", "要件不足", target.map((l) => l.kubun), `${side}_prior_kanri`, { premise: p }));
        return;
      }
    }
  }
  // 利用開始後 30 日まで（末期の悪性腫瘍以外。R8-248・R8-250）。開始日があるときだけ
  if (u.start !== null && !(terminal.known && terminal.value)) {
    const limit = addDays(u.start, cc.stayDays - 1);
    const late = days.filter((d) => d > limit);
    if (late.length > 0) out.findings.push(conditional("R20", "要件不足", visits.lines.filter((l) => l.dates.some((d) => late.includes(d))).map((l) => l.kubun), `${side}_30`, { premise, days: fmtDays(late) }, late));
  }
}

/** R21（ほかの機関）。design.md §18-4 の ⑤⑥⑦ */
export function judgeOthers(ctx: ClaimContext, c: RevisionConsts): Out {
  const out: Out = { findings: [], notes: new Set() };
  if (!c.care || !hasOthersScene(ctx, c)) return out;
  const cc = c.care;
  const kanri = kanriLines(ctx, c);
  const visit2 = ctx.lines.filter((l) => l.count > 0 && (c.visit2Kubun ?? []).includes(l.kubun));
  const shiji = ctx.lines.filter((l) => l.count > 0 && l.kubun === cc.shiji);
  const others = ctx.others;

  // ⑥ 同じ月に 2 回以上：求めの機関ごとに数えるかを当院の行から読めないので条件つき（申告によらない）
  const v2count = visit2.reduce((s, l) => s + l.count, 0);
  if (v2count >= 2) out.findings.push(conditional("R21", "要件不足", visit2.map((l) => l.kubun), "visit2_count", { premise: "求めた機関が 1 つなら", count: String(v2count) }));

  // ⑥ 求めた日から 6 か月を超える（R8-274・R8-275）。(Ⅰ)2 の行がある月は「ないと確かめた」を効かせない（C-512）
  if (visit2.length > 0) {
    const req = (others?.rows ?? []).filter((r) => r.activities["求めによる訪問診療の求めた側"] === "はい" && r.referredOn !== null);
    if (req.length === 0) out.notes.add(CARE_SCOPE_TEXT.noReferrer);
    for (const r of req) {
      const [y0, m0] = r.referredOn!.slice(0, 7).split("-").map(Number);
      const [y1, m1] = ctx.yearMonth.split("-").map(Number);
      const nth = (y1 - y0) * 12 + (m1 - m0) + 1;
      if (nth > cc.referralMonths) out.findings.push(conditional("R21", "要件不足", visit2.map((l) => l.kubun), "visit2_6m", { premise: premiseOf(`ほかの医療機関が ${r.referredOn} に訪問診療を求めた`, r, "、摘要欄に継続の理由・疾病等の記載がなければ") }));
    }
  }

  const relevant = kanri.length > 0 || shiji.length > 0;
  if (!relevant) return out;
  if (!others) {
    out.notes.add(CARE_SCOPE_TEXT.othersUnknown);
    return out;
  }
  // 「ないと確かめた」が効いていて、機関の行がなければ、⑤⑦ は何も出さない
  if (others.rows.length === 0) return out;

  // ⑤ 在医総管・施医総管は 1 機関（R8-270）
  if (kanri.length > 0) {
    if (others.rows.some((r) => r.kanriSide === "分からない")) out.notes.add(CARE_SCOPE_TEXT.othersUnknown);
    else {
      const r = others.rows.find((x) => x.kanriSide === "その機関");
      if (r) out.findings.push(conditional("R21", "要件不足", kanri.map((l) => l.kubun), "kanri_one", { premise: premiseOf("ほかの医療機関が在医総管・施医総管を算定", r) }));
    }
  }
  // ⑦ 特別の関係にある医療機関が訪問看護・指導料を算定した月の訪問看護指示料（R8-284。医療機関の決まり。ステーションには当てない。C-491）
  if (shiji.length > 0) {
    const med = others.rows.filter((r) => r.kind === "医療機関");
    const hit = med.find((r) => r.specialRelation === "はい" && r.activities["医療機関が行う訪問看護"] === "はい");
    if (hit) out.findings.push(conditional("R21", "要件不足", [cc.shiji], "shiji", { premise: premiseOf("特別の関係にある医療機関が今月、在宅患者訪問看護・指導料等を算定", hit) }));
    else if (med.some((r) => r.specialRelation === "分からない" || (r.specialRelation === "はい" && (r.activities["医療機関が行う訪問看護"] ?? "分からない") === "分からない"))) out.notes.add(CARE_SCOPE_TEXT.othersUnknown);
  }
  return out;
}

/** 点検の範囲に足す文（design.md §18-6）。場面の区分の行がある請求だけ。最初の行は「最初の版で見ている場面」 */
export function careScopeNotes(ctx: ClaimContext, c: RevisionConsts): string[] {
  if (!c.care || !(hasCareScene(ctx, c) || hasOthersScene(ctx, c))) return [];
  const notes = [...judgeCare(ctx, c).notes, ...judgeOthers(ctx, c).notes];
  return [CARE_SCOPE_TEXT.scenes, ...new Set(notes)];
}

/** その請求で、介護・ほかの機関の調整に「見ていません」があるか（月の一覧・聞き取りの対象に使う） */
export function careNotDone(ctx: ClaimContext, c: RevisionConsts): boolean {
  return careScopeNotes(ctx, c).length > 1;
}
