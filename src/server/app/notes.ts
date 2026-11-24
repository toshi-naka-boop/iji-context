// 本人が書く訪問カルテ（FR-69）：書く → AI が事実を取り出す → 本人が確かめる → その月の請求に重ねる
import { validateFacts, noteText, type ChartNote, type ExtractedFact } from "../../chart/extract";
import { claimMultiBandOf, claimNote14SideOf } from "../../engine/predicates";
import { tableKeyOfAct, tableKeyOfChild, validateActs, type AbbrevSummary, type ActChild, type ActFold, type ActMatch, type ChartAct, type RxChoice, type RxNote, type StoredActs, type TableKey, type Tbl } from "../../chart/acts";
import { matchItem, rowIn, rowsFor, searchRows, type Alias, type ItemMatch } from "../../chart/match";
import { rxDefault } from "../../chart/rx-default";
import { abbrevMarks, abbrevVocabOf, askedItems, itemKeyOf, linkedTokens, markDay, NO_MASTER_NOTE, type AbbrevVocab } from "../../chart/abbrev";
import { dispensingOf } from "../../facility/declaration";
import { readDeclarations } from "../../facility/seed";
import { withMasters } from "../../masters/db";
import { normName } from "../../notice/notice";
import { claimPreviewOf } from "../../chart/claim";
import { chartWithNotes, eventsFromNotes, withNotes, type ConfirmedNote, type VisitKind } from "../../chart/notes";
import { evaluate } from "../../engine";
import { manualIn } from "../../engine/compare";
import { deriveLines, manualLinesOf } from "../../engine/derive";
import { hasRevision, resolveRevision, revisionById, revisionChoices, SELECTABLE_REVISIONS } from "../../engine/revisions";
import { facilityOf } from "../../engine/facility";
import { r18SameFamily } from "../../generic/g11-rules";
import { trial } from "../../engine/trial";
import type { ClaimContext } from "../../engine/types";
import { monthRange } from "../../demo/period";
import type { Chart } from "../../uke/crosscheck";
import { commentCodesFor, commentFormatOk, type RequiredComment } from "../../engine/comments";
import type { Revision } from "../../engine/revisions/types";
import { commentOf, normalizeCommentText } from "../../uke/uke";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import type { Role } from "../roles";
import { contextAsOf, deferAtMidMonth, outlook, visitDays } from "../../visit/as-of";
import { chartFileOf } from "./case-files";
import { UNKNOWN_FACTS, type Cases } from "./cases";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import { json, type AppContext } from "./context";
import { declarationViewOf, facilityJsonOf, todayOf } from "./facility";
import { genericOfLines } from "./generic";
import { claimOfLines } from "../../generic/overlap";
import { createTorikawasure, type TextDay } from "./torikawasure";
import { ABBREV_WRITE_IN, createDoctorAbbrevs, forgetAbbrevAnswers } from "./doctor-abbrevs";
import { RULE_CODES, structuredConfig } from "../../structured/rule-codes";
import { hasTimeHint } from "../../structured/time-hint";
import { rxConfirmedOf, rxHashOf } from "../../structured/rx-mark";
import type { LocalAbout } from "./local-pairs";
import type { Structured } from "./structured";
import { overlap, type SItem, type StructuredReview } from "../../structured/overlap";

import type { Uke } from "./uke";

export function createNotes(ctx: AppContext, clock: Clock, clerks: Clerks, uke: Uke, casesOf: Cases, structured?: Structured) {
  const { sqlite, paths, hiddenClaim } = ctx;
  const { now } = clock;
  /** 施設の申告の三値（G10。design.md §15-5） */
  const declarationOf = () => declarationViewOf(ctx, clock);
  const { clerk } = clerks;
  const { patientOf } = uke;
  const { cases, caseOf, isUploaded } = casesOf;
  // 略語の医師への確認（FR-211）：問いと答え。答えは候補を作るときと B の欄の数に使う
  const abbrevs = createDoctorAbbrevs(ctx, clock, clerks, (claimId) => caseOf(claimId).yearMonth);
  const tori = createTorikawasure(ctx, clock, structured ? (claimId, ym, db) => structured.structuredRulesOf(claimId, ym, db) : undefined, structured ? (claimId, ym) => structured.devicesOnlyOf(claimId, ym) : undefined, abbrevs.stateOf);

  function saveNote(claimId: string, clerkId: string, kind: VisitKind, note: ChartNote): { id: number; date: string } {
    clerk(clerkId);
    const c = caseOf(claimId);
    // 訪問カルテは、その月の訪問の記録（出来事）に重ねて使う。記録のないレセプトは対象外
    if (isUploaded(claimId)) throw badRequest("アップロードした UKE のレセプトは、訪問カルテの対象外です（カルテ側の記録がないため）");
    if (kind !== "訪問診療" && kind !== "往診") throw badRequest(`訪問の種類が不正: ${kind}`);
    const date = now().slice(0, 10);
    if (!date.startsWith(c.yearMonth)) throw conflict(`今日（${date}）は診療月 ${c.yearMonth} の外。時計を診療月に戻してください`);
    const r = sqlite
      .prepare("INSERT INTO chart_notes (claim_id, date, kind, note, facts, clerk_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)")
      .run(claimId, date, kind, JSON.stringify(note), clerkId, now());
    return { id: Number(r.lastInsertRowid), date };
  }
  /**
   * 取り込んだ請求に、日付ごとにカルテの文を貼る（design.md §15-8 の「取り込んだ実在の請求にカルテを貼る」。L-100・L-122。段 18c）。
   * kind は「記録」で、訪問・往診の出来事は作らない（eventsFromNotes は読まない）。取り出すのは行ったこと（acts）だけで、事実は確かめない。
   * 貼れるのは、取り込んだ一覧にある請求の、その診療年月の日付だけ。確かめは今のカルテと同じ入口（POST /api/chart/acts）
   */
  function saveRecord(claimId: string, clerkId: string, date: string, note: ChartNote): { id: number; date: string } {
    clerk(clerkId);
    const ym = uke.receiptOf(claimId).receipt.yearMonth;
    if (!date.startsWith(`${ym}-`)) throw badRequest(`日付が診療年月（${ym}）の外です`, ["date"]);
    const r = sqlite
      .prepare("INSERT INTO chart_notes (claim_id, date, kind, note, facts, clerk_id, created_at) VALUES (?, ?, '記録', ?, NULL, ?, ?)")
      .run(claimId, date, JSON.stringify(note), clerkId, now());
    return { id: Number(r.lastInsertRowid), date };
  }
  /** 取り込んだ請求に貼って確かめたカルテ（書いた人によらない。請求ごと。貼るのは医療事務で、チームで見る） */
  function recordNotes(claimId: string): { id: number; date: string; acts: StoredActs }[] {
    return (sqlite.prepare("SELECT id, date, acts FROM chart_notes WHERE claim_id = ? AND kind = '記録' AND acts IS NOT NULL ORDER BY date, id").all(claimId) as { id: number; date: string; acts: string }[]).map((r) => ({
      id: r.id,
      date: r.date,
      acts: JSON.parse(r.acts) as StoredActs,
    }));
  }
  /** 貼って確かめたカルテのある請求と、請求ごとの貼った回数（段の報告：1 人あたりの貼った回数。L-122） */
  function recordCounts(): Map<string, number> {
    const rows = sqlite.prepare("SELECT claim_id, COUNT(*) AS n FROM chart_notes WHERE kind = '記録' AND acts IS NOT NULL GROUP BY claim_id").all() as { claim_id: string; n: number }[];
    return new Map(rows.map((r) => [r.claim_id, r.n]));
  }
  type NoteRow = { id: number; claim_id: string; date: string; kind: string; note: string; facts: string | null; acts: string | null; clerk_id: string };
  function noteRow(id: number): NoteRow {
    const r = sqlite.prepare("SELECT * FROM chart_notes WHERE id = ?").get(id) as NoteRow | undefined;
    if (!r) throw notFound(`カルテがない: ${id}`);
    return r;
  }
  const noteOf = (id: number) => JSON.parse(noteRow(id).note) as ChartNote;
  /**
   * 本人が確かめた事実で確定する。どの事実も、カルテに書かれた言葉（quote）を持っていなければならない。
   * 訪問カルテは、行ったことと同じく書いた本人だけが確定する（反証 round-56 C-311。ほかの人が事実だけを確定すると、本人が行ったことを残せなくなるため）
   */
  function confirmNote(id: number, clerkId: string, facts: ExtractedFact[]) {
    const r = noteRow(id);
    if (r.kind !== "記録" && r.clerk_id !== clerkId) throw forbidden("この訪問カルテを確定できるのは、書いた本人だけです");
    if (r.facts !== null) throw conflict(`もう確かめてある: ${id}`);
    const v = validateFacts({ facts }, JSON.parse(r.note) as ChartNote);
    if (v.dropped.length) throw badRequest(`カルテにない言葉の事実がある: ${v.dropped.map((d) => d.why).join("、")}`);
    // 略語の印（FR-211）は保存のときにサーバーが付け直す（画面から来た値は使わない）
    const vocab = withMasters((db) => abbrevVocabOf(db, caseOf(r.claim_id).yearMonth));
    const note = JSON.parse(r.note) as ChartNote;
    const day = vocab ? markDay([], v.facts, vocab, noteText(note)) : null;
    if (day) assertChosen(id, day.unlinked);
    sqlite.prepare("UPDATE chart_notes SET facts = ? WHERE id = ?").run(JSON.stringify(day ? day.facts : v.facts), id);
    return { claimId: r.claim_id, date: r.date };
  }
  // ───────────────────────────────────────────────────────────────────────
  // 分からない略語の印（spec FR-211。src/chart/abbrev.ts）。決まった規則だけで、LLM は使わない

  /**
   * 略語に結び付く書き方か（src/chart/abbrev.ts の linkedTokens と同じ規則。plan-fr211.md「規則の作り直し」3）：書かれた名前に分からない略語があるか、
   * 引用を渡したときは、書かれた名前が引用に含まれず引用に分からない略語があるか。結び付く書き方は、前に選んだ対応を読まない・書かない。LLM の lookup で候補を出さず、初期値に当てない
   */
  const markedIn = (vocab: AbbrevVocab | null) => (written: string, quote?: string) => vocab !== null && linkedTokens(written, quote ?? written, vocab).length > 0;
  /**
   * 取り出した直後の行ったこと・事実に印を付ける（FR-211）。聞く行為の lookup は空にする（保存もしない）。
   * 返すのは、印を付けた行ったこと・事実と、画面に出す印のまとめ
   */
  function markExtracted(id: number, acts: ChartAct[], facts: ExtractedFact[]): { acts: ChartAct[]; facts: ExtractedFact[]; abbrev: AbbrevSummary } {
    const r = noteRow(id);
    const yearMonth = caseOf(r.claim_id).yearMonth;
    return withMasters((db) => {
      const vocab = abbrevVocabOf(db, yearMonth);
      if (!vocab) return { acts, facts, abbrev: { unseen: NO_MASTER_NOTE } };
      const { acts: a, facts: f, marks, unlinked } = markDay(acts, facts, vocab, noteText(JSON.parse(r.note) as ChartNote));
      const asked = a.flatMap((x) => [x.abbrev && !x.match ? 1 : 0, ...(x.with ?? []).map((c) => (c.abbrev && !c.match ? 1 : 0))]).reduce<number>((n, k) => n + k, 0) + (r.kind === "記録" ? 0 : f.filter((x) => x.kind === "病名の記載" && x.abbrev).length);
      return { acts: a, facts: f, abbrev: { marks, asked, yearMonth, unlinked: unlinked.map((token) => ({ token, choice: abbrevs.choiceFor(id, token) })) } };
    });
  }
  /**
   * 確定の前に、残した記載（画面で外したものを除いた行為・事実）で印を判定し直す（round-99 C-651。保存しない）。
   * 外した記載に結び付いていた語は、結び付かない語として戻り、画面がその語の選ぶボタンを出し直す。権限は確定と同じ（訪問カルテは書いた本人だけ）
   */
  function recheckAbbrev(id: number, clerkId: string, input: { facts: ExtractedFact[]; acts: ChartAct[] }): AbbrevSummary {
    clerk(clerkId);
    const r = noteRow(id);
    if (r.kind !== "記録" && r.clerk_id !== clerkId) throw forbidden("この訪問カルテの行ったことを確かめられるのは、書いた本人だけです");
    const note = JSON.parse(r.note) as ChartNote;
    const facts = validateFacts({ facts: input.facts }, note).facts;
    const acts = validateActs({ acts: input.acts, rx: [] }, noteText(note), true).acts;
    return markExtracted(id, acts, r.kind === "記録" ? [] : facts).abbrev;
  }
  /**
   * 略語の確かめ待ち（規則の作り直し 4）：どの記載にも結び付かない語に、その月の扱い（算定に関係なし・医師に聞く）を選んでいなければ、確かめ済みにしない（409）
   */
  function assertChosen(noteId: number, unlinked: string[]) {
    const open = unlinked.filter((t) => abbrevs.choiceFor(noteId, t) === null);
    if (open.length > 0) throw conflict(`略語の確かめ待ちです：${open.join("・")} は、どの記載にも結び付いていません。「算定に関係なし」か「医師に聞く」を選んでから確かめてください`);
  }
  /** 自由記述の印の語（SOAP に整えたときに消えた略語を見るため）。請求がなければ・マスターがなければ空 */
  function abbrevMarksOf(claimId: string | undefined, text: string): string[] {
    if (!claimId) return [];
    const yearMonth = caseOf(claimId).yearMonth;
    return withMasters((db) => {
      const vocab = abbrevVocabOf(db, yearMonth);
      return vocab ? abbrevMarks(text, vocab) : [];
    });
  }
  // ───────────────────────────────────────────────────────────────────────
  // 行ったこと（design.md §15-6・15-7。段 18a）：マスターに当てる・候補・確かめて保存する。請求は見ない（C-233）

  /** その診療年月で効く申告の院内・院外（院外処方だけ・院内処方もある・分からない） */
  const dispensingFor = (yearMonth: string): RxChoice => dispensingOf(readDeclarations(sqlite), todayOf(clock), yearMonth);
  const tablesOfKey = (key: TableKey): Tbl[] => (key === "toyaku" ? ["iyakuhin", "shinryo"] : [key]);
  /**
   * 前に選んだ対応が、その診療年月の施設の申告で R18 の同じ族の区分誤りになるか（施設の種別・ベースアップ評価料の通常／注5。どの患者・どの日でも同じに決まる次元。C-250・C-263）。
   * 行と申告だけで決まるので、その行 1 つの請求に R18 を掛けて決める（決まった規則。LLM は使わない）。版のない診療年月は外さない
   */
  function kubunDoubt(yearMonth: string, a: Alias): boolean {
    if (a.tbl !== "shinryo" || !hasRevision(yearMonth)) return false;
    const rev = resolveRevision(yearMonth);
    const base: ClaimContext = { claimId: "", yearMonth, facility: facilityOf(facilityJsonOf(ctx, todayOf(clock), yearMonth)), payer: "支払基金", prefecture: "", facts: UNKNOWN_FACTS, events: [], recordsKnown: false, lines: [], commentsKnown: false };
    return r18SameFamily(base, rev, null)({ date: `${yearMonth}-01`, units: [{ items: [{ kind: "SI", code: a.code }], count: 1 }] }) !== null;
  }
  /**
   * 前に選んだ対応（引く表のうち、いちばん新しく選んだもの）。区分誤りの出る対応は、行を消さずに、ここで外す（初期値にも「前に選んだもの」にもしない。
   * 反証 round-55 C-293・C-300：点検・試算の GET で消していたのをやめた。申告を直せば、また使われる）
   */
  function aliasOf(written: string, key: TableKey, yearMonth: string): Alias | null {
    const t = tablesOfKey(key);
    const r = sqlite
      .prepare(`SELECT tbl, code FROM chart_act_aliases WHERE written_norm = ? AND tbl IN (${t.map(() => "?").join(", ")}) ORDER BY chosen_at DESC LIMIT 1`)
      .get(normName(written), ...t) as Alias | undefined;
    return r && !kubunDoubt(yearMonth, r) ? r : null;
  }
  type ActsReview = { dispensing: RxChoice; rxDefault: RxChoice; aliasCount: number; mastersPresent: boolean; matches: { act: ItemMatch; with: ItemMatch[] }[] };
  /**
   * 確かめる画面に並べる当て方（行為ごと・with の子ごと）と、その診療年月の申告の院内・院外、処方の文から決めた院内・院外の初期値（C-243）。
   * 前に選んだ対応は選んだ状態の初期値で出す（保存は本人の確かめのあと。L-95）。引数に請求を持たない（C-233）
   */
  function actsReview(yearMonth: string, acts: ChartAct[], rx: RxNote[]): ActsReview {
    return withMasters((db) => {
      const rows = new Map<TableKey, ReturnType<typeof rowsFor>>();
      const rowsOf = (k: TableKey) => {
        if (!rows.has(k)) rows.set(k, rowsFor(db, k, yearMonth));
        return rows.get(k)!;
      };
      // 印のある書き方（FR-211）は、前に選んだ対応を読まず、LLM の lookup で候補を出さない（書かれた名前の部分一致の候補は出す）
      const marked = markedIn(abbrevVocabOf(db, yearMonth));
      // 印のある記載は、名称の完全一致でも自動では当てない（初期値を出さない。X-490：言い換えた書き方が名称と一致しても、原文の略語は医師に聞く）
      const one = (k: TableKey, written: string, quote: string, lookup: string[]) =>
        marked(written, quote) ? { initial: null, candidates: matchItem(rowsOf(k), k, written, [], null).candidates } : matchItem(rowsOf(k), k, written, lookup, aliasOf(written, k, yearMonth));
      const matches = acts.map((a) => ({ act: one(tableKeyOfAct(a.category), a.written, a.quote, a.lookup), with: (a.with ?? []).map((c) => one(tableKeyOfChild(c.kind), c.written, c.quote, c.lookup)) }));
      const aliasCount = matches.flatMap((m) => [m.act, ...m.with]).filter((m) => m.initial?.by === "alias").length;
      return { dispensing: dispensingFor(yearMonth), rxDefault: rxDefault(rx), aliasCount, mastersPresent: db !== null, matches };
    });
  }
  /** カルテの id から、確かめる画面の当て方と、その日の入力の場面（処方の日の印・訪問の時刻。design.md §16-6） */
  function actsReviewOf(id: number, acts: ChartAct[], rx: RxNote[]): ActsReview & { structured: StructuredReview | null } & DayInputs {
    const r = noteRow(id);
    const yearMonth = caseOf(r.claim_id).yearMonth;
    const review = actsReview(yearMonth, acts, rx);
    const n = JSON.parse(r.note) as ChartNote;
    return {
      ...review,
      structured: structuredReview(r.claim_id, yearMonth, r.date, acts.map((a, i) => ({ ...a, match: review.matches[i]?.act.initial ?? null }))),
      ...dayInputsOf(r.claim_id, yearMonth, r.date, review.rxDefault, [n.s, n.o, n.a, n.p].filter(Boolean).join("\n")),
    };
  }
  type VisitRef = { ref: string; kind: "訪問診療" | "往診" | null };
  /**
   * その日の入力の場面（design.md §16-4-1・16-6。効く日だけ。決まった規則だけで、LLM は使わない）：
   * rxMark：処方の日の「確かめた」の印が効くか（n2＝オーダーを受け取っている在医総管の月のオーダーのない日、chozai＝オーダーを受け取っていない在医総管のない月の院内の日。C-441）。
   * visitTime：訪問の時刻の入力欄を出すか（その日の訪問の時刻が受け取れない・欠けていて、S・O・A・P に時間の語があるか請求のその日に患家診療時間加算がある日。visits はその日の電子カルテの訪問。C-442）
   */
  type DayInputs = { rxMark: "n2" | "chozai" | null; visitTime: { visits: VisitRef[] } | null };
  function dayInputsOf(claimId: string, yearMonth: string, date: string, choice: RxChoice | null, soap: string): DayInputs {
    if (!structured || !hasRevision(yearMonth)) return { rxMark: null, visitTime: null };
    const rev = resolveRevision(yearMonth);
    const lines = caseOf(claimId).lines;
    const kanriKubun = new Set(rev.consts.kanri.rows.map((k) => k.kubun));
    const kanri = lines.some((l) => kanriKubun.has(l.kubun));
    const s = withMasters((db) => structured.structuredItemsOf(claimId, yearMonth, db));
    // 構造化データのない請求は、注2・時間の加算を見ないので印・時刻の入力を促さない（v34 の 16-4-1）。調剤料・処方料の印（オーダーのない月の院内の日）は出す
    const orders = s?.chart.orders;
    const rxMark = orders?.status === "supported" ? (kanri && !orders.items.some((o) => o.date === date) ? "n2" : null) : !kanri && dispensingFor(yearMonth) === "inside" && choice === "inside" ? "chozai" : null;
    if (!s) return { rxMark, visitTime: null };
    const full = (v: { start: string | null; end: string | null }) => !!v.start && !!v.end && v.end > v.start;
    const onDay = s.chart.visits.status === "supported" ? s.chart.visits.items.filter((v) => v.date === date) : [];
    const clerkTimes = structured.visitTimesOf(structured.structuredPatientOf(claimId), yearMonth).filter((t) => t.date === date);
    const missing = onDay.filter((v) => !full(v) && !clerkTimes.some((t) => t.ref === v.ref));
    const known = onDay.some(full) || (onDay.length === 0 && clerkTimes.length > 0);
    if (known || (onDay.length > 0 && missing.length === 0)) return { rxMark, visitTime: null };
    const KAKA: string[] = [RULE_CODES.kakaVisit, RULE_CODES.kakaOushin, RULE_CODES.kakaOushinSpecial];
    const kaka = lines.some((l) => l.dates.includes(date) && Object.hasOwn(rev.codes, l.kubun) && [rev.codes[l.kubun].primary, ...rev.codes[l.kubun].accept].some((c) => KAKA.includes(c)));
    return { rxMark, visitTime: hasTimeHint(soap) || kaka ? { visits: missing.map((v) => ({ ref: v.ref, kind: v.kind })) } : null };
  }
  /**
   * 確かめる画面の構造化データの欄（design.md §16-3・16-7）：その日の構造化データの行為（読むだけ。出どころの印つき）と、行為ごとの見分け（初期値の当て方で突き合わせた結果）。
   * 当てられない行為には、その日の同じ種類の構造化データの行為を並べる（「同じ／違う／選ばない」。初期値は出さない）。構造化データを残していない月は null
   */
  function structuredReview(claimId: string, yearMonth: string, date: string, acts: ChartAct[]): StructuredReview | null {
    if (!structured || !hasRevision(yearMonth)) return null;
    return withMasters((db) => {
      const s = structured.structuredItemsOf(claimId, yearMonth, db);
      if (!s) return null;
      const ov = overlap(acts.map((act, i) => ({ date, key: String(i), act })), s.items, s.chart, resolveRevision(yearMonth));
      const brief = (x: SItem) => ({ ref: x.ref, kind: x.kind, name: x.name, ...(x.quantity ? { quantity: x.quantity } : {}), ...(x.visitKind !== undefined ? { visitKind: x.visitKind } : {}), mapped: x.code !== null });
      return {
        source: "電子カルテ",
        parts: Object.fromEntries(Object.entries(s.chart).map(([k, p]) => [k, p.status])) as StructuredReview["parts"],
        day: s.items.filter((x) => x.date === date).map(brief),
        acts: acts.map((_, i) => {
          const o = ov.acts.get(String(i))!;
          return o.status === "unmatched" ? { status: o.status, pairs: o.pairs.map(brief) } : o.status === "folded" ? { status: o.status, refs: o.refs } : o.status === "textOnly" ? { status: o.status, note: o.note } : { status: o.status };
        }),
      };
    });
  }
  /** 本人が選んだ「同じ／違う」の印を確かめる：当てられない行為に、その日の同じ種類の構造化データの行為（ref）があるときだけ（design.md §16-3） */
  function checkFold(claimId: string, yearMonth: string, date: string, act: ChartAct, fold: ActFold | undefined): ActFold | undefined {
    if (!fold) return undefined;
    if (act.match) throw badRequest("当たっている行為には「同じ／違う」を付けません", ["acts"]);
    if (fold.kind !== "order" || fold.by !== "person") throw badRequest("付けられる印は、本人が選んだ「同じ／違う」だけです", ["acts"]);
    if (fold.same === false) return { kind: "order", by: "person", same: false };
    const pairs = structuredReview(claimId, yearMonth, date, [act])?.acts[0];
    if (!fold.ref || pairs?.status !== "unmatched" || !pairs.pairs.some((x) => x.ref === fold.ref)) throw badRequest("その日の同じ種類の電子カルテの行為ではありません", ["acts"]);
    return { kind: "order", ref: fold.ref, by: "person" };
  }
  /**
   * 1 つの行為の候補（書かれた名前・lookup を直したとき）。15-7 の並べ方で、実在するコードだけを 20 件まで。
   * 印のある書き方（FR-211）は、前に選んだ対応と画面の lookup を使わない。at（保存したカルテの行為の位置）を渡すと、その記載に効く医師の「指すものを記入する」の答えの語だけを lookup にする（自動では当てない）
   */
  function actCandidates(key: TableKey, yearMonth: string, written: string, lookup: string[], at?: { noteId: number; index: number; child?: number }, quote?: string): ItemMatch {
    return withMasters((db) =>
      // 保存したカルテの位置を渡したときは、保存のときの印（引用の原文の語を含む。X-490）も見る
      // 確かめる画面の引き直しは引用も渡す（C-630。引用で決めた印を、引き直しで外さない）
      markedIn(abbrevVocabOf(db, yearMonth))(written, quote) || (at !== undefined && storedItemAt(at, written)?.abbrev?.length)
        ? { initial: null, candidates: matchItem(rowsFor(db, key, yearMonth), key, written, at ? doctorWordsAt(at, written) : [], null).candidates }
        : matchItem(rowsFor(db, key, yearMonth), key, written, lookup, aliasOf(written, key, yearMonth)),
    );
  }
  /** 保存したカルテの行為・子に効く、医師の「指すものを記入する」の答えの語（書かれた名前が合わない・印がなければ空） */
  /** 保存したカルテの行為・子（書かれた名前が合わなければ null） */
  function storedItemAt(at: { noteId: number; index: number; child?: number }, written?: string): ChartAct | ActChild | null {
    const r = sqlite.prepare("SELECT acts FROM chart_notes WHERE id = ?").get(at.noteId) as { acts: string | null } | undefined;
    if (!r?.acts) return null;
    const act = (JSON.parse(r.acts) as StoredActs).acts[at.index];
    const item = at.child === undefined ? act : act?.with?.[at.child];
    return item && (written === undefined || normName(item.written) === normName(written)) ? item : null;
  }
  function doctorWordsAt(at: { noteId: number; index: number; child?: number }, written?: string): string[] {
    const item = storedItemAt(at, written);
    if (!item?.abbrev?.length) return [];
    return abbrevs.writtenIn(at.noteId, at.child === undefined ? "act" : "child", itemKeyOf(item.written, item.quote), item.abbrev);
  }
  /** マスターを名前で探す（名称の部分一致で 20 件まで。表・コード・名称だけ） */
  function searchMasters(key: TableKey, yearMonth: string, q: string) {
    return withMasters((db) => searchRows(rowsFor(db, key, yearMonth), q).map(({ tbl, code, name }) => ({ tbl, code, name })));
  }
  /**
   * 事実と行ったことを、本人が確かめた 1 回の操作で保存する（FR-95・FR-192）。どれもカルテに書かれた言葉（quote）を持っていなければならない。
   * 当てたコードは、診療年月の 1 枚の、category で決めた表に実在するものだけ（名称はマスターの値に置き換える）。
   * 本人が候補・探す・前に選んだものから選んだ対応は、クリニックごとに残す（L-95）。院内・院外は、院内処方もある施設で処方の記載がある日だけ残し、規則の初期値のままかを印にする（C-243）
   */
  function confirmActs(id: number, clerkId: string, input: { facts: ExtractedFact[]; acts: ChartAct[]; rx: RxNote[]; rxChoice: RxChoice | null; rxConfirmed?: boolean }) {
    clerk(clerkId);
    const r = noteRow(id);
    // 訪問カルテ（訪問診療・往診）は書いた本人の算定プレビューに重なるので、書いた本人だけが確かめる。貼ったカルテ（記録）はチームで見る（反証 round-55 C-302）
    if (r.kind !== "記録" && r.clerk_id !== clerkId) throw forbidden("この訪問カルテの行ったことを確かめられるのは、書いた本人だけです");
    if (r.facts !== null) throw conflict(`もう確かめてある: ${id}`);
    const note = JSON.parse(r.note) as ChartNote;
    const v = validateFacts({ facts: input.facts }, note);
    if (v.dropped.length) throw badRequest(`カルテにない言葉の事実がある: ${v.dropped.map((d) => d.why).join("、")}`);
    const a = validateActs({ acts: input.acts, rx: input.rx }, noteText(note), true);
    if (a.dropped.length) throw badRequest(`カルテにない言葉の行ったことがある: ${[...new Set(a.dropped.map((d) => d.why))].join("、")}`);
    const yearMonth = caseOf(r.claim_id).yearMonth;
    const chosen: { written: string; quote: string; key: TableKey; m: ActMatch }[] = [];
    const at = now();
    let vocab: AbbrevVocab | null = null;
    let markedFacts: ExtractedFact[] = v.facts;
    let unlinked: string[] = [];
    const acts = withMasters((db) => {
      const rows = new Map<TableKey, ReturnType<typeof rowsFor>>();
      const check = (key: TableKey, written: string, quote: string, m: ActMatch | null | undefined): ActMatch | null => {
        if (!m) return null;
        if (!rows.has(key)) rows.set(key, rowsFor(db, key, yearMonth));
        const row = rowIn(rows.get(key)!, m.tbl, m.code);
        if (!row) throw badRequest(`診療年月のマスターの、この行為の表にないコードです: ${m.code}`, ["acts"]);
        const out = { tbl: row.tbl, code: row.code, name: row.name, by: m.by };
        if (m.by !== "name") chosen.push({ written, quote, key, m: out });
        return out;
      };
      const checked = a.acts.map((x, i) => {
        const src = input.acts[i];
        const act: ChartAct = { ...x, match: check(tableKeyOfAct(x.category), x.written, x.quote, src.match) };
        const fold = checkFold(r.claim_id, yearMonth, r.date, act, src.fold);
        if (fold) act.fold = fold;
        if (x.with) act.with = x.with.map((c, j) => ({ ...c, match: check(tableKeyOfChild(c.kind), c.written, c.quote, src.with?.[j]?.match) }));
        return act;
      });
      // 略語の印（FR-211）：当てたあとに付け直す（聞く行為の lookup は残さない）。印のある書き方は、選んだ対応をクリニックごとに覚えない
      vocab = abbrevVocabOf(db, yearMonth);
      if (!vocab) return checked;
      const marked = markedIn(vocab);
      for (let k = chosen.length - 1; k >= 0; k--) if (marked(chosen[k].written, chosen[k].quote)) chosen.splice(k, 1);
      const day = markDay(checked, v.facts, vocab, noteText(note));
      markedFacts = day.facts;
      unlinked = day.unlinked;
      return day.acts;
    });
    assertChosen(id, unlinked);
    const inside = dispensingFor(yearMonth) === "inside" && a.rx.length > 0;
    const rule = rxDefault(a.rx);
    const choice = inside ? (input.rxChoice ?? rule) : null;
    // 「確かめた」の印（design.md §16-4-1）：値を選び直したか、「確かめた」を押したときだけ。初期値のまま保存しただけでは付けない
    const marked = choice !== null && (choice !== rule || input.rxConfirmed === true);
    const abbrev: StoredActs["abbrev"] = vocab ? { marks: abbrevMarks(noteText(note), vocab), at } : { noMaster: true, at };
    const stored: StoredActs = { acts, rx: a.rx, rxChoice: choice, rxChoiceBy: choice === null ? null : choice === rule ? "rule" : "person", rxConfirmed: marked ? { by: clerkId, at, rxHash: rxHashOf(a.rx) } : null, abbrev };
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE chart_notes SET facts = ?, acts = ? WHERE id = ?").run(JSON.stringify(markedFacts), JSON.stringify(stored), id);
      for (const c of chosen) {
        const wn = normName(c.written);
        // 投薬は医薬品と第5部の両方を引くので、別の表に残した対応は外す（同じ書き方の対応は 1 つ）
        for (const t of tablesOfKey(c.key)) if (t !== c.m.tbl) sqlite.prepare("DELETE FROM chart_act_aliases WHERE written_norm = ? AND tbl = ?").run(wn, t);
        sqlite
          .prepare("INSERT INTO chart_act_aliases (written_norm, tbl, code, chosen_by, chosen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(written_norm, tbl) DO UPDATE SET code = excluded.code, chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at")
          .run(wn, c.m.tbl, c.m.code, clerkId, at);
      }
    })();
    return { claimId: r.claim_id, date: r.date };
  }
  /**
   * 確かめて残したカルテの、当てられない行為（match が null）を、本人が候補・探す・前に選んだものから選んで当てる（design.md §15-7・15-9 の
   * B の欄「当てられない行為（候補から選ぶ入口）」。反証 round-55 X-157）。次の点検から、その行為を突き合わせる。
   * 当てたコードは confirmActs と同じく、診療年月の 1 枚の、category で決めた表に実在するものだけ（名称はマスターの値に置き換える）。選んだ対応はクリニックごとに残す（L-95）。
   * もう当たっている行為は直さない（409）。訪問カルテは書いた本人だけ（C-302 と同じ）。返すのは請求と日だけ。
   * child を渡すと、その行為で使った薬・器材（with の位置）を当てる。表は子の種類で決め、権限・検査は親と同じ（X-161）
   */
  function pickAct(id: number, clerkId: string, index: number, match: ActMatch, child?: number) {
    clerk(clerkId);
    const r = noteRow(id);
    if (r.kind !== "記録" && r.clerk_id !== clerkId) throw forbidden("この訪問カルテの行ったことを確かめられるのは、書いた本人だけです");
    if (r.acts === null) throw conflict(`まだ確かめていないカルテ: ${id}`);
    const stored = JSON.parse(r.acts) as StoredActs;
    const act = stored.acts[index];
    if (!act) throw badRequest("このカルテにない行為です", ["index"]);
    const kid = child === undefined ? undefined : act.with?.[child];
    if (child !== undefined && !kid) throw badRequest("この行為にない薬・器材です", ["child"]);
    if ((kid ?? act).match) throw conflict("この行為はもう当たっています");
    if (match.by === "name") throw badRequest("選んだ当て方ではありません", ["match"]);
    const key = kid ? tableKeyOfChild(kid.kind) : tableKeyOfAct(act.category);
    // 医師の答えの語の候補から選んだもの（FR-211）は by を doctor にする（その記載に効く「指すものを記入する」の答えの語で、同じ並べ方の候補に入るとき）
    const words = (kid ?? act).abbrev?.length ? doctorWordsAt({ noteId: id, index, ...(child !== undefined ? { child } : {}) }) : [];
    const { row, fromDoctor } = withMasters((db) => {
      const rows = rowsFor(db, key, caseOf(r.claim_id).yearMonth);
      return { row: rowIn(rows, match.tbl, match.code), fromDoctor: words.length > 0 && matchItem(rows, key, "", words, null).candidates.some((c) => c.tbl === match.tbl && c.code === match.code) };
    });
    if (!row) throw badRequest(`診療年月のマスターの、この行為の表にないコードです: ${match.code}`, ["match"]);
    const m: ActMatch = { tbl: row.tbl, code: row.code, name: row.name, by: fromDoctor ? "doctor" : match.by };
    const next: StoredActs = { ...stored, acts: stored.acts.map((a, i) => (i !== index ? a : kid ? { ...a, with: a.with!.map((x, j) => (j === child ? { ...x, match: m } : x)) } : { ...a, match: m })) };
    const wn = normName((kid ?? act).written);
    // 印のある書き方（FR-211。保存のときの印）は、選んだ対応をクリニックごとに覚えない
    const remember = !(kid ?? act).abbrev?.length;
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE chart_notes SET acts = ? WHERE id = ?").run(JSON.stringify(next), id);
      if (!remember) return;
      for (const t of tablesOfKey(key)) if (t !== m.tbl) sqlite.prepare("DELETE FROM chart_act_aliases WHERE written_norm = ? AND tbl = ?").run(wn, t);
      sqlite
        .prepare("INSERT INTO chart_act_aliases (written_norm, tbl, code, chosen_by, chosen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(written_norm, tbl) DO UPDATE SET code = excluded.code, chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at")
        .run(wn, m.tbl, m.code, clerkId, now());
    })();
    return { claimId: r.claim_id, date: r.date };
  }
  /**
   * 確かめて残したカルテの当てられない行為に、16-3 の「同じ（ref）／違う／選ばない」をあとから付ける（POST /api/chart/acts/fold。design.md §16-7。round-66 C-421）。
   * 権限は pickAct と同じ（訪問カルテは書いた本人だけ、貼ったカルテはチーム）。「選ばない」は印を外す。返すのは請求と日だけ
   */
  function foldAct(id: number, clerkId: string, index: number, choice: "same" | "different" | "none", ref?: string) {
    clerk(clerkId);
    const r = noteRow(id);
    if (r.kind !== "記録" && r.clerk_id !== clerkId) throw forbidden("この訪問カルテの行ったことを確かめられるのは、書いた本人だけです");
    if (r.acts === null) throw conflict(`まだ確かめていないカルテ: ${id}`);
    const stored = JSON.parse(r.acts) as StoredActs;
    const act = stored.acts[index];
    if (!act) throw badRequest("このカルテにない行為です", ["index"]);
    const yearMonth = caseOf(r.claim_id).yearMonth;
    const fold = choice === "none" ? undefined : checkFold(r.claim_id, yearMonth, r.date, act, choice === "same" ? { kind: "order", by: "person", ...(ref ? { ref } : {}) } : { kind: "order", by: "person", same: false });
    const next: StoredActs = { ...stored, acts: stored.acts.map((a, i) => (i !== index ? a : (({ fold: _, ...rest }) => (fold ? { ...rest, fold } : rest))(a))) };
    sqlite.prepare("UPDATE chart_notes SET acts = ? WHERE id = ?").run(JSON.stringify(next), id);
    return { claimId: r.claim_id, date: r.date };
  }
  /**
   * 確かめて残したカルテの、その日の処方の欄の値と「確かめた」の印を付け直す（POST /api/chart/acts/rx-confirm。design.md §16-4-1・16-7。C-421）。
   * 権限は pickAct と同じ。処方の欄を出すのは、院内処方もある施設で、処方の記載か投薬の行為がある日だけ。印はそのときの処方の文の指紋を持つ。返すのは請求と日だけ
   */
  function confirmRx(id: number, clerkId: string, input: { rxChoice: RxChoice; confirmed: boolean }) {
    clerk(clerkId);
    const r = noteRow(id);
    if (r.kind !== "記録" && r.clerk_id !== clerkId) throw forbidden("この訪問カルテの行ったことを確かめられるのは、書いた本人だけです");
    if (r.acts === null) throw conflict(`まだ確かめていないカルテ: ${id}`);
    const stored = JSON.parse(r.acts) as StoredActs;
    if (dispensingFor(caseOf(r.claim_id).yearMonth) !== "inside") throw badRequest("施設の申告が院内処方もある施設でないので、処方の院内・院外の欄はありません");
    if (stored.rx.length === 0 && !stored.acts.some((a) => a.category === "投薬")) throw badRequest("この日のカルテに処方の記載も投薬もありません");
    const rule = rxDefault(stored.rx);
    const next: StoredActs = { ...stored, rxChoice: input.rxChoice, rxChoiceBy: input.rxChoice === rule ? "rule" : "person", rxConfirmed: input.confirmed ? { by: clerkId, at: now(), rxHash: rxHashOf(stored.rx) } : null };
    sqlite.prepare("UPDATE chart_notes SET acts = ? WHERE id = ?").run(JSON.stringify(next), id);
    return { claimId: r.claim_id, date: r.date };
  }
  /** カルテの請求の id（画面の操作の前に構造化データを読むため。C-440） */
  const claimIdOfNote = (id: number): string => noteRow(id).claim_id;
  /**
   * 確かめたあとで付け直す一覧（GET /api/chart/acts/fixes。design.md §16-4-1・16-3・16-7。C-441）：その請求の確かめて残したカルテのうち、
   * 処方の日の印の効く日で印がない日（rxMark）と、当てられない行為に同じ日の電子カルテの同じ種類の行為があるもの（pairs）。見える範囲は確かめる画面と同じ
   * （取り込んだ請求は貼ったカルテ〔チーム〕、合成の症例は本人が書いたカルテ）。返すのはカルテの id・日・処方の文・行為の書かれた名前と電子カルテの表示名だけ。
   * 病名の記載に医師が「指すものを記入する」で答えていれば、その記載と答えの語（doctorAnswers。X-492）も返す（その記載を開き直したときの札）
   */
  function confirmedFixes(claimId: string, clerkId: string) {
    clerk(clerkId);
    const rows = (
      isUploaded(claimId)
        ? sqlite.prepare("SELECT * FROM chart_notes WHERE claim_id = ? AND kind = '記録' AND acts IS NOT NULL ORDER BY date, id").all(claimId)
        : sqlite.prepare("SELECT * FROM chart_notes WHERE claim_id = ? AND clerk_id = ? AND acts IS NOT NULL ORDER BY date, id").all(claimId, clerkId)
    ) as NoteRow[];
    const yearMonth = caseOf(claimId).yearMonth;
    const inside = dispensingFor(yearMonth) === "inside";
    return rows.flatMap((r) => {
      const stored = JSON.parse(r.acts!) as StoredActs;
      const n = JSON.parse(r.note) as ChartNote;
      const hasRx = stored.rx.length > 0 || stored.acts.some((a) => a.category === "投薬");
      const choice = stored.rxChoice ?? (stored.rx.length > 0 ? rxDefault(stored.rx) : null);
      const mark = inside && hasRx && !rxConfirmedOf(stored) ? dayInputsOf(claimId, yearMonth, r.date, choice, [n.s, n.o, n.a, n.p].filter(Boolean).join("\n")).rxMark : null;
      const review = structuredReview(claimId, yearMonth, r.date, stored.acts);
      const pairs = (review?.acts ?? []).flatMap((o, index) =>
        o.status === "unmatched" && o.pairs.length > 0 && !stored.acts[index].match
          ? [{ index, written: stored.acts[index].written, pairs: o.pairs.map((x) => ({ ref: x.ref, name: x.name })), fold: stored.acts[index].fold ?? null }]
          : [],
      );
      // 病名の記載への医師の「指すものを記入する」の答え（FR-211。反証 round-96 X-492）：表示するだけで、事実の値は書き換えず、取り出し・判定にも使わない
      const facts = r.facts === null ? null : (JSON.parse(r.facts) as ExtractedFact[]);
      const doctorAnswers = askedItems(r.kind, null, facts).flatMap((it) => {
        const got = abbrevs.answersOf(r.id, "fact", it.key, it.tokens).filter((x) => x.answer.option === ABBREV_WRITE_IN && x.answer.freeText);
        return got.length > 0 ? [{ index: it.index, value: it.written, quote: it.quote, answers: got.map((x) => ({ token: x.token, text: x.answer.freeText! })) }] : [];
      });
      if (mark === null && pairs.length === 0 && doctorAnswers.length === 0) return [];
      return [{ noteId: r.id, date: r.date, rx: stored.rx.map((x) => x.quote), rxChoice: choice, rxMark: mark, pairs, ...(doctorAnswers.length > 0 ? { doctorAnswers } : {}) }];
    });
  }
  /** 保存した行ったこと（確かめていなければ null） */
  const savedActs = (id: number): StoredActs | null => {
    const r = noteRow(id);
    return r.acts === null ? null : (JSON.parse(r.acts) as StoredActs);
  };

  /**
   * 訪問カルテを消す（design.md §11-11「消す」）。消せるのは、書いた本人と事務長だけ（ロールは権限表が先に絞る。ここでは本人かどうかを照合する）。
   * 消えるのは、そのカルテの行（本文と、そこから確かめた事実）と、そのカルテの算定プレビューで入れた摘要欄の記載。訪問の出来事と算定行は保存しておらず、残りのカルテから毎回作り直すので、消したカルテの分は次の計算から外れる。
   * 返すのは消したカルテの id だけ（本文・請求の中身は返さない）
   */
  function deleteNote(id: number, clerkId: string, role: Role): { deleted: number } {
    const r = noteRow(id);
    if (r.clerk_id !== clerkId && role !== "manager") throw forbidden("このカルテを消せるのは、書いた本人と事務長だけです");
    // そのカルテの算定プレビューで入れた摘要欄の記載も一緒に消す
    sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM chart_comments WHERE note_id = ?").run(id);
      // 略語の医師への答え（FR-211）のうち、このカルテの記載の分と、記載のなくなった答え
      forgetAbbrevAnswers(sqlite, [id]);
      sqlite.prepare("DELETE FROM chart_notes WHERE id = ?").run(id);
    })();
    return { deleted: id };
  }
  /**
   * 訪問カルテの一覧（消す相手を選ぶため）。見えるのは消せる分だけ：事務長には全部、ほかの人には自分が書いた分。
   * 返すのは、id・請求・日付・種類・書いた人の名前・確定済みか。本文と、そこから確かめた事実は返さない
   */
  function listNotes(clerkId: string, role: Role) {
    const rows = sqlite
      .prepare("SELECT n.id, n.claim_id, n.date, n.kind, n.clerk_id, n.facts IS NOT NULL AS confirmed, c.name FROM chart_notes n LEFT JOIN clerks c ON c.id = n.clerk_id ORDER BY n.id")
      .all() as { id: number; claim_id: string; date: string; kind: string; clerk_id: string; confirmed: number; name: string | null }[];
    return rows
      .filter((r) => (role === "manager" || r.clerk_id === clerkId) && !hiddenClaim(r.claim_id))
      .map((r) => ({ id: r.id, claimId: r.claim_id, date: r.date, kind: r.kind, writer: r.name ?? "", mine: r.clerk_id === clerkId, confirmed: r.confirmed === 1 }));
  }
  /** 本人が書いて確かめた訪問カルテ（利用者ごと。ほかの人が書いたカルテは重ねない） */
  function confirmedNotes(claimId: string, clerkId?: string): ConfirmedNote[] {
    if (!clerkId) return [];
    return (sqlite.prepare("SELECT * FROM chart_notes WHERE claim_id = ? AND clerk_id = ? AND facts IS NOT NULL ORDER BY id").all(claimId, clerkId) as NoteRow[]).map((r) => ({
      date: r.date,
      kind: r.kind as VisitKind,
      note: JSON.parse(r.note) as ChartNote,
      facts: JSON.parse(r.facts!) as ExtractedFact[],
      acts: r.acts === null ? null : (JSON.parse(r.acts) as StoredActs),
    }));
  }
  /**
   * B の欄（G11）に渡す、日ごとの行ったこと：取り込んだ請求（合成の症例でない）は貼って確かめたカルテ、合成の症例は合成カルテの acts に、
   * 本人が確かめたカルテの acts を重ねる（同じ日は確かめたカルテで置き換える）。upTo を渡すと、その日までの分
   */
  function actsDays(claimId: string, clerkId?: string, upTo?: string) {
    if (isUploaded(claimId)) return tori.storedDays(recordNotes(claimId)).filter((d) => upTo === undefined || d.date <= upTo);
    const mine = clerkId ? (sqlite.prepare("SELECT id, date, acts FROM chart_notes WHERE claim_id = ? AND clerk_id = ? AND acts IS NOT NULL ORDER BY date, id").all(claimId, clerkId) as { id: number; date: string; acts: string }[]) : [];
    const own = tori.storedDays(mine.map((r) => ({ id: r.id, date: r.date, acts: JSON.parse(r.acts) as StoredActs })));
    const dates = new Set(own.map((d) => d.date));
    return [...tori.chartDays(claimId).filter((d) => !dates.has(d.date)), ...own].filter((d) => upTo === undefined || d.date <= upTo).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  /** 1 つの請求の、カルテの文章のある日（確かめたかは問わない）。取り込んだ請求は貼ったカルテ、合成の症例は合成カルテの文に本人のカルテを重ねる */
  function claimTexts(claimId: string, clerkId?: string): TextDay[] {
    const join = (n: ChartNote) => [n.s, n.o, n.a, n.p, n.rx].filter(Boolean).join("\n");
    const soapOf = (n: ChartNote) => [n.s, n.o, n.a, n.p].filter(Boolean).join("\n");
    type R = { date: string; note: string; acts: string | null };
    const rows = (
      isUploaded(claimId)
        ? sqlite.prepare("SELECT date, note, acts FROM chart_notes WHERE claim_id = ? AND kind = '記録' ORDER BY date, id").all(claimId)
        : clerkId
          ? sqlite.prepare("SELECT date, note, acts FROM chart_notes WHERE claim_id = ? AND clerk_id = ? ORDER BY date, id").all(claimId, clerkId)
          : []
    ) as R[];
    const own: TextDay[] = rows.map((r) => ({ date: r.date, text: join(JSON.parse(r.note) as ChartNote), soap: soapOf(JSON.parse(r.note) as ChartNote), stored: r.acts === null ? null : (JSON.parse(r.acts) as StoredActs) }));
    if (isUploaded(claimId)) return own;
    const dates = new Set(own.map((d) => d.date));
    return [...tori.chartTextDays(claimId).filter((d) => !dates.has(d.date)), ...own];
  }
  /**
   * G11 の規則の候補（design.md §16-4-5 (e)・(d)）に渡すカルテの文章：当月と、同じ患者のさかのぼる月の請求（構造化データを残していない請求は読まない）
   */
  function textsOf(claimId: string, clerkId?: string): { texts: TextDay[]; pastTextsUnreadable: boolean } {
    if (!structured) return { texts: claimTexts(claimId, clerkId), pastTextsUnreadable: false };
    let past: TextDay[] = [];
    let pastTextsUnreadable = false;
    try {
      const ym = isUploaded(claimId) ? uke.receiptOf(claimId).receipt.yearMonth : caseOf(claimId).yearMonth;
      const months = structured.monthsBefore(ym, structuredConfig().rxLookbackMonths);
      past = structured.samePatientClaims(claimId, months).flatMap((x) => claimTexts(x.claimId, clerkId));
    } catch {
      // 例外を黙って捨てない：さかのぼる月の文章を「ない」と読まず、読めないとして G11 に渡す（注2 は「見ていません」。C-454）
      past = [];
      pastTextsUnreadable = true;
    }
    return { texts: [...claimTexts(claimId, clerkId), ...past], pastTextsUnreadable };
  }
  /** その月の請求：UKE の症例に、本人が書いた訪問を重ねる（訪問の時点の問題で使う。月末の UKE の問題は UKE のまま） */
  const monthOf = (claimId: string, clerkId?: string): ClaimContext => withNotes(caseOf(claimId), confirmedNotes(claimId, clerkId));
  type SavedComment = { slot: string; code: string; text: string };
  const savedComments = (noteId: number) => sqlite.prepare("SELECT slot, code, text FROM chart_comments WHERE note_id = ?").all(noteId) as SavedComment[];
  /**
   * 導出の摘要欄の記載のうち、人が入れるもの（needsInput）に場所（slot）と当たるコードを添え、入れた値があれば ready にする。
   * slot は「記載の表の行|導出が決めたコード（選ぶなら空）|同じ行とコードの何件目」。値を推し量って埋めることはしない（入れた値がなければ needsInput のまま）
   */
  function withInputs(comments: RequiredComment[], saved: SavedComment[], rev: Revision, ctx: ClaimContext) {
    const seen = new Map<string, number>();
    return comments.map((c) => {
      if (c.status !== "needsInput") return c;
      const base = `${c.rule}|${c.code ?? ""}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const slot = `${base}|${n}`;
      const rule = rev.comments.find((x) => x.id === c.rule);
      const codes = c.code !== null ? [c.code] : rule ? commentCodesFor(rule, ctx, rev) : [];
      const input = { slot, codes };
      const s = saved.find((x) => x.slot === slot && codes.includes(x.code));
      return s ? { ...c, code: s.code, text: s.text, status: "ready" as const, input } : { ...c, input };
    });
  }
  /**
   * 算定プレビューの「入力が要る」記載に、医療事務が値を入れる（FR-176。design.md §11-13）。確定したカルテ（請求とその日）ごとに残し、同じ場所は置き換える。
   * コードは記載の表のその行のコード（導出がコードを決めていれば、そのコード）だけ。値は半角に寄せてから、コードの先頭 3 桁の形式（commentFormatOk）で確かめ、合わなければ残さない。
   * 返すのは場所だけ（値は返さない。ログにも出さない）
   */
  function saveNoteComment(id: number, clerkId: string, input: { slot: string; code: string; text: string }): { saved: string } {
    clerk(clerkId);
    const r = noteRow(id);
    if (r.facts === null) throw conflict(`まだ確かめていないカルテ: ${id}`);
    const [ruleId, slotCode] = input.slot.split("|");
    const rule = resolveRevision(caseOf(r.claim_id).yearMonth).comments.find((x) => x.id === ruleId);
    if (!rule || (slotCode !== "" && !rule.codes.includes(slotCode))) throw badRequest("摘要欄の記載の場所が正しくありません", ["slot"]);
    if (!rule.codes.includes(input.code) || (slotCode !== "" && input.code !== slotCode)) throw badRequest("この記載に使えないコードです", ["code"]);
    const text = normalizeCommentText(input.text);
    if (!commentFormatOk(input.code, text)) throw badRequest("値の形が、コードの形式に合いません", ["text"]);
    sqlite
      .prepare("INSERT INTO chart_comments (note_id, claim_id, date, slot, code, text, clerk_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(note_id, slot) DO UPDATE SET code = excluded.code, text = excluded.text, clerk_id = excluded.clerk_id, created_at = excluded.created_at")
      .run(id, r.claim_id, r.date, input.slot, input.code, text, clerkId, now());
    return { saved: input.slot };
  }
  /**
   * 確定したカルテの算定プレビュー（FR-94〜102）：その日までの出来事に、書いた人の確定済みのカルテを重ね、算定行をコードで導出して検証に通す。
   * 月の途中は見込み（月末まで決まらないルールは指摘にしない）。読むだけで、適用記録・件数には数えない。choices は要選択への答え（保存しない）。
   * 摘要欄の記載（R17）は、導出が値まで決めた記載（ready）だけを付けて点検する。UKE のコメントは使わない（行を作り直しているので、行と合わない）。
   * 人が入れる記載（needsInput）は、医療事務がこのカルテのプレビューで入れた値（saveNoteComment）があれば ready として付け、なければ付けないので記載もれとして出る（design.md §11-13）。
   * revId を渡すと試算（design.md §11-12）：同じ記録を、名指しした版の点数表とルールで導出・判定する。日付は動かさない。
   * 手入力の行は、その版の点数表にある区分だけを通し、通さなかった区分を notInRevision に名前で返す。結果は試算の型（TrialResult）で、保存しない。
   * revisions は、試算で選べる版（画面の選択肢。own は、この請求の診療年月の版）
   */
  function claimOfNote(id: number, choices: Record<string, string>, revId?: string, local?: LocalAbout) {
    const r = noteRow(id);
    if (r.facts === null) throw conflict(`まだ確かめていないカルテ: ${id}`);
    const base = caseOf(r.claim_id);
    const own = resolveRevision(base.yearMonth);
    const rev = revId === undefined ? own : revisionById(revId);
    if (!rev) throw badRequest("選べる版ではありません", ["rev"]);
    const midMonth = r.date < monthRange(base.yearMonth).end;
    const upTo = midMonth ? contextAsOf(base, r.date) : base;
    const { events, facts } = eventsFromNotes(upTo.events, upTo.facts, confirmedNotes(r.claim_id, r.clerk_id).filter((n) => n.date <= r.date));
    const ownManual = manualLinesOf(upTo.lines, own);
    const manual = revId === undefined ? ownManual : manualIn(ownManual, rev);
    // 原請求の 10 人以上の管理料の注14 の側は、日で絞る前の請求の全部の行から求める（round-58 C-333）。比べる版に減の行がなければ「なし」
    const claimNote14Side = rev.consts.kanri.note14Pairs ? claimNote14SideOf(base.lines, own.consts) : "なし";
    // 原請求の 2 人以上の区分の管理料の行も、日で絞る前の請求の全部の行から求める（round-61 X-200）
    const claimMultiBand = claimMultiBandOf(base.lines, own.consts);
    const plain = deriveLines({ yearMonth: upTo.yearMonth, facility: upTo.facility, facts, events, history: upTo.history, ...(upTo.care ? { care: upTo.care } : {}), manual, choices, claimNote14Side, claimMultiBand, ...(midMonth ? { asOf: r.date } : {}) }, rev);
    // 人が入れる記載（needsInput）に、このカルテで医療事務が入れた値があれば、ready の記載として付ける（FR-176）
    const derived = { ...plain, comments: withInputs(plain.comments, savedComments(id), rev, { ...upTo, events, facts, lines: plain.lines, comments: [], commentsKnown: true }) };
    const comments = derived.comments.flatMap((c) => (c.status === "ready" ? [commentOf(c.code!, c.text!, [c.kubun])] : []));
    const ctx: ClaimContext = { ...upTo, events, facts, lines: derived.lines, comments, commentsKnown: true };
    const revisions = revisionChoices(SELECTABLE_REVISIONS, base.yearMonth);
    // データで動く点検（G01〜。design.md §12-5）：導出した行の区分をコードに直して掛ける。試算では、選んだ版の世代のマスターで。
    // 重なりの規則には、月の途中で外す前の手書きの結果を渡す（外した指摘と同じことを、データの側から出さない）
    if (revId === undefined) {
      const result = evaluate(ctx);
      // 背反の組の院内の知識（design.md §14-3）は、診療年月の版の算定プレビューにだけ渡す（試算には渡さない）。算定プレビューでは USED を出さない
      // 施設の申告（G10。design.md §15-5）は算定プレビューに渡す（版を名指しした試算にも渡す：診療年月の版を名指しした試算は、省いた呼び出しと同じ結果にする）
      const { localUsed: _used, ...generic } = genericOfLines(derived.lines, rev, base.yearMonth, result, ctx.recordsKnown, local, declarationOf());
      // B の欄（G11。design.md §15-9）：導出の算定行と、その日までの確かめた行ったこと（path は preview。g11Owned の区分は見ない）
      const torikawasure = tori.run({ claim: claimOfLines(derived.lines, rev).claim, base: ctx, rev, path: "preview", days: actsDays(r.claim_id, r.clerk_id, r.date), hand: result.findings });
      return { claimId: r.claim_id, date: r.date, revisions, ...claimPreviewOf(derived, midMonth ? deferAtMidMonth(result) : result, rev), generic, torikawasure };
    }
    const result = trial(ctx, rev);
    const { localUsed: _unused, ...generic } = genericOfLines(derived.lines, rev, base.yearMonth, result, ctx.recordsKnown, undefined, declarationOf());
    const notInRevision = [...new Set(ownManual.filter((l) => !manual.includes(l)).map((l) => own.points[l.kubun].name))];
    // B の欄も同じに出す（診療年月の版を名指しした試算は、省いた呼び出しと同じ結果にする）
    const torikawasure = tori.run({ claim: claimOfLines(derived.lines, rev).claim, base: ctx, rev, path: "preview", days: actsDays(r.claim_id, r.clerk_id, r.date), hand: result.findings });
    return { claimId: r.claim_id, date: r.date, revisions, ...claimPreviewOf(derived, midMonth ? deferAtMidMonth(result) : result, rev), generic, torikawasure, trial: result.trial, rulesAvailable: result.rulesAvailable, notInRevision };
  }
  /** カルテを書く患者の一覧（訪問のある患者。氏名などは合成データ） */
  function patients() {
    return cases()
      .filter((c) => visitDays(c).length > 0)
      .map((c) => {
        const p = patientOf(c.claimId);
        const f = c.facts;
        const v = <T,>(x: { known: boolean; value?: T }) => (x.known ? (x as { value: T }).value : null);
        return {
          claimId: c.claimId,
          name: p.name,
          sex: p.sex === 1 ? "男" : "女",
          age: v(f.age),
          insurance: v(f.insurance),
          mainDisease: v(f.mainDisease),
          diseases: p.diseases.map((d) => d.name),
          careLevel: v(f.careLevel),
          table7: v(f.table7),
          table8_2: v(f.table8_2),
          homeOxygen: v(f.homeOxygen),
        };
      });
  }

  /** 訪問の記録（レセコンに入れる前）：その月の訪問日と、その日のカルテ。デモデータとして、時計に関係なく全部の訪問で練習できる（2026-11-07 ユーザー判断） */
  function visits(clerkId?: string) {
    return cases().map((c) => monthOf(c.claimId, clerkId)).flatMap((c) =>
      visitDays(c).map((d) => ({
        claimId: c.claimId,
        date: d.date,
        type: d.type,
        mainDisease: c.facts.mainDisease.known ? c.facts.mainDisease.value : null,
        chart: chartOf(c.claimId, clerkId)?.entries.find((e) => e.date === d.date) ?? null,
        /** その日までの実施（レセコンに入れる前の下書きの元） */
        lines: contextAsOf(c, d.date).lines,
        outlook: outlook(c, d.date),
        /** 本人が書いた訪問か */
        written: confirmedNotes(c.claimId, clerkId).some((n) => n.date === d.date),
      })),
    ).sort((a, b) => (a.date === b.date ? (a.claimId < b.claimId ? -1 : 1) : a.date < b.date ? -1 : 1));
  }
  /** 照合用のカルテ：合成カルテに、本人が書いて確かめた訪問カルテを重ねる（FR-69） */
  function chartOf(claimId: string, clerkId?: string): Chart | null {
    // 請求 id はパスに使わず、表を引く（合成カルテのない症例・表にない請求 id は null）
    const f = chartFileOf(paths.root, claimId);
    // 処方の一覧を持たない合成カルテ（K8〜K13 の確かめたあとの形）は、処方の一覧を空として読む
    const c = f ? json<Chart>(f) : null;
    return chartWithNotes(c ? { ...c, prescriptions: c.prescriptions ?? [] } : null, claimId, confirmedNotes(claimId, clerkId));
  }

  /** どの記載にも結び付かない語の扱いを、一覧でまとめて選ぶ（事務。GET・POST /api/chart/abbrev-choices） */
  const { chooseAbbrev, abbrevChoiceList } = abbrevs;
  return { abbrevs, chooseAbbrev, abbrevChoiceList, recheckAbbrev, markExtracted, abbrevMarksOf, claimIdOfNote, confirmedFixes, saveNote, saveRecord, recordNotes, recordCounts, actsDays, textsOf, torikawasure: tori, noteOf, confirmNote, confirmActs, actsReviewOf, actCandidates, searchMasters, savedActs, pickAct, foldAct, confirmRx, deleteNote, listNotes, confirmedNotes, monthOf, claimOfNote, saveNoteComment, patients, visits, chartOf };
}

export type Notes = ReturnType<typeof createNotes>;
