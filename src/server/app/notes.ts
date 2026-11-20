// 本人が書く訪問カルテ（FR-69）：書く → AI が事実を取り出す → 本人が確かめる → その月の請求に重ねる
import { validateFacts, type ChartNote, type ExtractedFact } from "../../chart/extract";
import { claimPreviewOf } from "../../chart/claim";
import { chartWithNotes, eventsFromNotes, withNotes, type ConfirmedNote, type VisitKind } from "../../chart/notes";
import { evaluate } from "../../engine";
import { manualIn } from "../../engine/compare";
import { deriveLines, manualLinesOf } from "../../engine/derive";
import { resolveRevision, revisionById } from "../../engine/revisions";
import { trial } from "../../engine/trial";
import type { ClaimContext } from "../../engine/types";
import { monthRange } from "../../patient/profile";
import type { Chart } from "../../uke/crosscheck";
import { commentOf } from "../../uke/uke";
import { badRequest, conflict, notFound } from "../errors";
import { contextAsOf, deferAtMidMonth, outlook, visitDays } from "../../visit/as-of";
import { chartFileOf } from "./case-files";
import type { Cases } from "./cases";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import { json, type AppContext } from "./context";
import type { Uke } from "./uke";

export function createNotes(ctx: AppContext, clock: Clock, clerks: Clerks, uke: Uke, casesOf: Cases) {
  const { sqlite, paths } = ctx;
  const { now } = clock;
  const { clerk } = clerks;
  const { patientOf } = uke;
  const { cases, caseOf, isUploaded } = casesOf;

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
  type NoteRow = { id: number; claim_id: string; date: string; kind: string; note: string; facts: string | null; clerk_id: string };
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
  /** 本人が書いて確かめた訪問カルテ（利用者ごと。ほかの人が書いたカルテは重ねない） */
  function confirmedNotes(claimId: string, clerkId?: string): ConfirmedNote[] {
    if (!clerkId) return [];
    return (sqlite.prepare("SELECT * FROM chart_notes WHERE claim_id = ? AND clerk_id = ? AND facts IS NOT NULL ORDER BY id").all(claimId, clerkId) as NoteRow[]).map((r) => ({
      date: r.date,
      kind: r.kind as VisitKind,
      note: JSON.parse(r.note) as ChartNote,
      facts: JSON.parse(r.facts!) as ExtractedFact[],
    }));
  }
  /** その月の請求：UKE の症例に、本人が書いた訪問を重ねる（訪問の時点の問題で使う。月末の UKE の問題は UKE のまま） */
  const monthOf = (claimId: string, clerkId?: string): ClaimContext => withNotes(caseOf(claimId), confirmedNotes(claimId, clerkId));
  /**
   * 確定したカルテの算定プレビュー（FR-94〜102）：その日までの出来事に、書いた人の確定済みのカルテを重ね、算定行をコードで導出して検証に通す。
   * 月の途中は見込み（月末まで決まらないルールは指摘にしない）。読むだけで、適用記録・件数には数えない。choices は要選択への答え（保存しない）。
   * 摘要欄の記載（R17）は、導出が値まで決めた記載（ready）だけを付けて点検する。UKE のコメントは使わない（行を作り直しているので、行と合わない）。
   * 人が入れる記載（needsInput）は、付いていないので記載もれとして出る（design.md §11-13）。
   * revId を渡すと試算（design.md §11-12）：同じ記録を、名指しした版の点数表とルールで導出・判定する。日付は動かさない。
   * 手入力の行は、その版の点数表にある区分だけを通し、通さなかった区分を notInRevision に名前で返す。結果は試算の型（TrialResult）で、保存しない
   */
  function claimOfNote(id: number, choices: Record<string, string>, revId?: string) {
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
    const derived = deriveLines({ yearMonth: upTo.yearMonth, facility: upTo.facility, facts, events, history: upTo.history, manual, choices, ...(midMonth ? { asOf: r.date } : {}) }, rev);
    const comments = derived.comments.flatMap((c) => (c.status === "ready" ? [commentOf(c.code!, c.text!, [c.kubun])] : []));
    const ctx: ClaimContext = { ...upTo, events, facts, lines: derived.lines, comments, commentsKnown: true };
    if (revId === undefined) {
      const result = evaluate(ctx);
      return { claimId: r.claim_id, date: r.date, ...claimPreviewOf(derived, midMonth ? deferAtMidMonth(result) : result, rev) };
    }
    const result = trial(ctx, rev);
    const notInRevision = [...new Set(ownManual.filter((l) => !manual.includes(l)).map((l) => own.points[l.kubun].name))];
    return { claimId: r.claim_id, date: r.date, ...claimPreviewOf(derived, midMonth ? deferAtMidMonth(result) : result, rev), trial: result.trial, rulesAvailable: result.rulesAvailable, notInRevision };
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

  return { saveNote, noteOf, confirmNote, confirmedNotes, monthOf, claimOfNote, patients, visits, chartOf };
}

export type Notes = ReturnType<typeof createNotes>;
