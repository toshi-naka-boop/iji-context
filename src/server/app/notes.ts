// 本人が書く訪問カルテ（FR-69）：書く → AI が事実を取り出す → 本人が確かめる → その月の請求に重ねる
import { validateFacts, noteText, type ChartNote, type ExtractedFact } from "../../chart/extract";
import { tableKeyOfAct, tableKeyOfChild, validateActs, type ActMatch, type ChartAct, type RxChoice, type RxNote, type StoredActs, type TableKey, type Tbl } from "../../chart/acts";
import { matchItem, rowIn, rowsFor, searchRows, type Alias, type ItemMatch } from "../../chart/match";
import { rxDefault } from "../../chart/rx-default";
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
import { createTorikawasure } from "./torikawasure";
import type { LocalAbout } from "./local-pairs";
import type { Uke } from "./uke";

export function createNotes(ctx: AppContext, clock: Clock, clerks: Clerks, uke: Uke, casesOf: Cases) {
  const { sqlite, paths, hiddenClaim } = ctx;
  const { now } = clock;
  /** 施設の申告の三値（G10。design.md §15-5） */
  const declarationOf = () => declarationViewOf(ctx, clock);
  const { clerk } = clerks;
  const { patientOf } = uke;
  const { cases, caseOf, isUploaded } = casesOf;
  const tori = createTorikawasure(ctx, clock);

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
  /** 本人が確かめた事実で確定する。どの事実も、カルテに書かれた言葉（quote）を持っていなければならない */
  function confirmNote(id: number, facts: ExtractedFact[]) {
    const r = noteRow(id);
    if (r.facts !== null) throw conflict(`もう確かめてある: ${id}`);
    const v = validateFacts({ facts }, JSON.parse(r.note) as ChartNote);
    if (v.dropped.length) throw badRequest(`カルテにない言葉の事実がある: ${v.dropped.map((d) => d.why).join("、")}`);
    sqlite.prepare("UPDATE chart_notes SET facts = ? WHERE id = ?").run(JSON.stringify(v.facts), id);
    return { claimId: r.claim_id, date: r.date };
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
      const one = (k: TableKey, written: string, lookup: string[]) => matchItem(rowsOf(k), k, written, lookup, aliasOf(written, k, yearMonth));
      const matches = acts.map((a) => ({ act: one(tableKeyOfAct(a.category), a.written, a.lookup), with: (a.with ?? []).map((c) => one(tableKeyOfChild(c.kind), c.written, c.lookup)) }));
      const aliasCount = matches.flatMap((m) => [m.act, ...m.with]).filter((m) => m.initial?.by === "alias").length;
      return { dispensing: dispensingFor(yearMonth), rxDefault: rxDefault(rx), aliasCount, mastersPresent: db !== null, matches };
    });
  }
  /** カルテの id から、確かめる画面の当て方 */
  function actsReviewOf(id: number, acts: ChartAct[], rx: RxNote[]): ActsReview {
    return actsReview(caseOf(noteRow(id).claim_id).yearMonth, acts, rx);
  }
  /** 1 つの行為の候補（書かれた名前・lookup を直したとき）。15-7 の並べ方で、実在するコードだけを 20 件まで */
  function actCandidates(key: TableKey, yearMonth: string, written: string, lookup: string[]): ItemMatch {
    return withMasters((db) => matchItem(rowsFor(db, key, yearMonth), key, written, lookup, aliasOf(written, key, yearMonth)));
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
  function confirmActs(id: number, clerkId: string, input: { facts: ExtractedFact[]; acts: ChartAct[]; rx: RxNote[]; rxChoice: RxChoice | null }) {
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
    const chosen: { written: string; key: TableKey; m: ActMatch }[] = [];
    const acts = withMasters((db) => {
      const rows = new Map<TableKey, ReturnType<typeof rowsFor>>();
      const check = (key: TableKey, written: string, m: ActMatch | null | undefined): ActMatch | null => {
        if (!m) return null;
        if (!rows.has(key)) rows.set(key, rowsFor(db, key, yearMonth));
        const row = rowIn(rows.get(key)!, m.tbl, m.code);
        if (!row) throw badRequest(`診療年月のマスターの、この行為の表にないコードです: ${m.code}`, ["acts"]);
        const out = { tbl: row.tbl, code: row.code, name: row.name, by: m.by };
        if (m.by !== "name") chosen.push({ written, key, m: out });
        return out;
      };
      return a.acts.map((x, i) => {
        const src = input.acts[i];
        const act: ChartAct = { ...x, match: check(tableKeyOfAct(x.category), x.written, src.match) };
        if (x.with) act.with = x.with.map((c, j) => ({ ...c, match: check(tableKeyOfChild(c.kind), c.written, src.with?.[j]?.match) }));
        return act;
      });
    });
    const inside = dispensingFor(yearMonth) === "inside" && a.rx.length > 0;
    const rule = rxDefault(a.rx);
    const choice = inside ? (input.rxChoice ?? rule) : null;
    const stored: StoredActs = { acts, rx: a.rx, rxChoice: choice, rxChoiceBy: choice === null ? null : choice === rule ? "rule" : "person" };
    const at = now();
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE chart_notes SET facts = ?, acts = ? WHERE id = ?").run(JSON.stringify(v.facts), JSON.stringify(stored), id);
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
    const plain = deriveLines({ yearMonth: upTo.yearMonth, facility: upTo.facility, facts, events, history: upTo.history, manual, choices, ...(midMonth ? { asOf: r.date } : {}) }, rev);
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
    return chartWithNotes(f ? json<Chart>(f) : null, claimId, confirmedNotes(claimId, clerkId));
  }

  return { saveNote, saveRecord, recordNotes, recordCounts, actsDays, torikawasure: tori, noteOf, confirmNote, confirmActs, actsReviewOf, actCandidates, searchMasters, savedActs, deleteNote, listNotes, confirmedNotes, monthOf, claimOfNote, saveNoteComment, patients, visits, chartOf };
}

export type Notes = ReturnType<typeof createNotes>;
