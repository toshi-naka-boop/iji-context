// 注14 の計算の道具（design.md §15-13。FR-204。段 17i〜17k）：確認月の期間の回数を取り込んだ UKE から数え、本人の入力と合わせて判定し、結果を note14_worksheets に追記で残す。
// 道具は申告を書き換えない（L-132）。「申告の下書きを開く」は、申告の画面に値を入れた状態で開くための値を返すだけ。判定（R01〜R19・G01〜G11）はこの表を読まない。
// 記録・応答・監査ログに、患者の氏名・生年月日・番号・鍵を出さない（数だけ。鍵はメモリの中だけで作る）
import type Database from "better-sqlite3";
import { hasRevision, resolveRevision } from "../../engine/revisions";
import type { Note14Result } from "../../facility/note14";
import { isExpired } from "../../patient/facts";
import { AUTO_TEXT, countMonths, type AutoMonth } from "../../note14/count";
import { draftOf as stage2DraftOf, DRAFT_TEXT, type Draft, type DraftReceipt } from "../../note14/drafts";
import { fieldKeys } from "../../note14/readings";
import { evaluate, isCheckMonth, monthsBefore, periodOf, shiftMonth, toolConstsOf, type Evaluation, type MonthCount, type Note14Consts, type Period, type WorksheetInput } from "../../note14/evaluate";
import type { User } from "../auth";
import { badRequest, conflict, notFound } from "../errors";
import type { Note14WorksheetBody } from "../schemas/note14";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import type { Patients } from "./patients";
import type { Uke } from "./uke";

type Row = { id: number; check_month: string; period_3m_from: string; period_3m_to: string; period_12m_from: string; period_12m_to: string; inputs: string; outcomes: string; result: string; splits: string; checked_by: string; checked_on: string; created_at: string };
type Stored = Extract<Evaluation, { status: "done" }>;

export const NOTE14_TOOL_TEXT = {
  outOfScope: "この確認月は道具の対象外です",
  notCheckMonth: "確認月以外の結果での届出の要否は示されていません",
  draftNote: "通知の一般の決まりによる読みです。厚生局に確かめてください",
  undecided: (month: string) => `注14：決めきれないまま（${month}）`,
  open: "注14 の確認月です。計算表を開く",
} as const;

/** その年月の版の、計算の道具の値（なければ対象外） */
export const toolConstsAt = (ym: string): Note14Consts | null => (hasRevision(ym) ? toolConstsOf(resolveRevision(ym).consts.note14) : null);

const readRows = (sqlite: Database.Database): Row[] => sqlite.prepare("SELECT * FROM note14_worksheets ORDER BY id").all() as Row[];

/** 申告との比べに使う結果（確認月の結果だけ。確認月以外の結果は比べない。design.md §15-2） */
export function note14ResultsFromDb(sqlite: Database.Database): Note14Result[] {
  return readRows(sqlite).flatMap((r) => {
    const k = toolConstsAt(r.check_month);
    return k && isCheckMonth(r.check_month, k) ? [{ checkMonth: r.check_month, outcome: r.result as Note14Result["outcome"], seq: r.id }] : [];
  });
}

/** 今日以前で最も新しい確認月（道具の初期値） */
export function latestCheckMonth(today: string): string | null {
  const ym = today.slice(0, 7);
  for (let i = 0; i < 12; i++) {
    const m = shiftMonth(ym, -i);
    const k = toolConstsAt(m);
    if (k && isCheckMonth(m, k)) return m;
  }
  return null;
}

function view(r: Row) {
  const o = JSON.parse(r.outcomes) as Pick<Stored, "outcomes" | "lines" | "reasons" | "remaining" | "stage2Open">;
  const k = toolConstsAt(r.check_month);
  const checkMonth = k !== null && isCheckMonth(r.check_month, k);
  return {
    id: r.id,
    checkMonth: r.check_month,
    isCheckMonth: checkMonth,
    period: { short: { from: r.period_3m_from, to: r.period_3m_to }, long: { from: r.period_12m_from, to: r.period_12m_to } } satisfies Period,
    inputs: JSON.parse(r.inputs) as unknown,
    result: r.result as Stored["result"],
    splits: JSON.parse(r.splits) as string[],
    ...o,
    checkedBy: r.checked_by,
    checkedOn: r.checked_on,
    /** 下書きを作れるか（決めきれない・確認月以外の結果では作らない） */
    draft: r.result !== "undecided" && checkMonth,
    ...(checkMonth ? {} : { note: NOTE14_TOOL_TEXT.notCheckMonth }),
  };
}
export type WorksheetView = ReturnType<typeof view>;

export function createNote14(ctx: Pick<AppContext, "sqlite">, clock: Pick<Clock, "now">, uke: Pick<Uke, "parsedClaims" | "ukeReceipts">, patients: Pick<Patients, "existingIdOf" | "latestPatientFacts">) {
  const today = () => clock.now().slice(0, 10);

  /**
   * 2 段目の下書き（段 17k）：期間の 3 か月の取り込んだ請求の管理料の行（版の管理料の表で族を決める）と、除く患者の行（版の在宅ターミナルケア加算・看取り加算・死亡診断加算）、
   * 患者の事実（要介護 3 以上・別表第八の二。患者マスタにない患者・事実のない患者は未入力）から作る
   */
  function stage2Draft(months: string[]): Draft {
    // 読めない請求（読み直しで読めない・未対応・版がない）も外さずに渡し、その月は下書きに使わない（0 人と数えない。round-61 X-202・C-373）
    const receipts: DraftReceipt[] = uke
      .ukeReceipts()
      .filter((r) => months.includes(r.yearMonth))
      .map((r) => {
        if (r.unreadable || r.noRevision || !hasRevision(r.yearMonth)) return { yearMonth: r.yearMonth, patient: r.patient, families: [], excluded: false, unreadable: true };
        const c = resolveRevision(r.yearMonth).consts;
        const family = new Map(c.kanri.rows.map((x) => [x.kubun, x.family]));
        const ex = new Set([c.terminal.mitori, c.terminal.shibou, ...Object.values(c.terminal.terminal)]);
        const live = r.lines.filter((l) => l.count > 0);
        return { yearMonth: r.yearMonth, patient: r.patient, families: [...new Set(live.flatMap((l) => (family.has(l.kubun) ? [family.get(l.kubun)!] : [])))], excluded: live.some((l) => ex.has(l.kubun)) };
      });
    const now = clock.now();
    return stage2DraftOf(receipts, months, (p) => {
      const id = patients.existingIdOf(p);
      if (id === null) return null;
      const facts = patients.latestPatientFacts(id).filter((f) => !isExpired(f, now));
      const care = facts.find((f) => f.key === "careLevel")?.value;
      const t8 = facts.find((f) => f.key === "table8_2")?.value;
      if (care !== undefined && Number(care) >= 3) return true;
      if (t8 === true) return true;
      return care !== undefined && t8 === false ? false : null;
    });
  }

  /** 期間の月ごとの自動の数（その月の版の別表で数える。別表のない月・取り込みのない月・重なる月は数えない） */
  const autoOf = (months: string[]): AutoMonth[] => countMonths(uke.parsedClaims(), months, (m) => toolConstsAt(m)?.countRows ?? null);

  /** 道具の画面（GET /api/note14）：確認月と期間、版の値、月ごとの自動の数、その確認月の結果の一覧 */
  function tool(month?: string) {
    const m = month ?? latestCheckMonth(today());
    if (m === null) return { month: null, outOfScope: true, text: NOTE14_TOOL_TEXT.outOfScope };
    const k = toolConstsAt(m);
    if (!k) return { month: m, outOfScope: true, text: NOTE14_TOOL_TEXT.outOfScope };
    const period = periodOf(m, k);
    const auto = autoOf(monthsBefore(m, k.periodMonths.short)).map((a) => ({ ...a, ...(a.state === "ok" ? {} : { text: a.state === "unreadable" ? `${AUTO_TEXT.unreadable}（読めない請求 ${a.unreadable} 枚）` : AUTO_TEXT[a.state] }) }));
    return {
      month: m,
      outOfScope: false,
      isCheckMonth: isCheckMonth(m, k),
      ...(isCheckMonth(m, k) ? {} : { note: NOTE14_TOOL_TEXT.notCheckMonth }),
      period,
      consts: k,
      auto,
      // 2 段目の下書き（数だけ。鍵・患者の情報は返さない）
      draft: (() => {
        const d = stage2Draft(monthsBefore(m, k.periodMonths.short));
        // notes：下書きしない欄・足りないかもしれない欄の案内（たたまずに出す）
        return d.ok ? { ...d, text: d.unknownCare > 0 ? DRAFT_TEXT.unknownCare(d.unknownCare) : null, notes: [DRAFT_TEXT.excludedPartial, DRAFT_TEXT.careEnd] } : d;
      })(),
      worksheets: readRows(ctx.sqlite).filter((r) => r.check_month === m).map(view),
    };
  }

  /** 送られた入力を、判定に渡す形にする（確かめた月は自動の数、確かめていない月は手入力の数） */
  function inputOf(body: Note14WorksheetBody, k: Note14Consts): WorksheetInput {
    const want = monthsBefore(body.checkMonth, k.periodMonths.short);
    if (body.stage1.months.map((x) => x.month).join() !== want.join()) throw badRequest(`期間の月（${want.join("・")}）ごとに入れてください`, ["stage1"]);
    const auto = new Map(autoOf(want).map((a) => [a.month, a]));
    const months: MonthCount[] = body.stage1.months.map((x) => {
      const a = auto.get(x.month)!;
      if (x.confirmed) {
        if (a.state !== "ok") throw badRequest(`${x.month}：${AUTO_TEXT[a.state]}`, ["stage1"]);
        return { month: x.month, kou: a.kou, otsuExtra: a.otsuExtra, source: "auto" };
      }
      return { month: x.month, kou: x.kou ?? null, otsuExtra: x.otsuExtra ?? null, source: "manual" };
    });
    const s = body.stage1;
    const n = (x: number | null | undefined) => x ?? null;
    const stage1 = { months, gansou: n(s.gansou), secondPatient: n(s.secondPatient), special: s.special, institutions: s.institutions.map((i) => ({ openedOn: i.openedOn ?? null, ownerChangedFrom: i.ownerChangedFrom ?? null, count: n(i.count), otsuExtra: n(i.otsuExtra) })), openedOn: s.openedOn ?? null };
    if (!body.stage2) return { stage1 };
    const keys = new Set(fieldKeys().map((x) => x.key));
    const bad = Object.keys(body.stage2.values).find((key) => !keys.has(key));
    if (bad !== undefined) throw badRequest("2 段目の欄の鍵が違います", ["stage2"]);
    const values = Object.fromEntries([...keys].map((key) => [key, n(body.stage2!.values[key])]));
    // 出どころ：送られた印が「自動」で、値がサーバーの下書きと同じ欄だけを自動にする（本人が直した欄・下書きのない欄は手入力）。
    // 1 段目で「全患者分を取り込んだ」を確かめていない月があれば、下書きの元がそろっているか分からないので自動にしない（round-61 C-373。L-134）
    const draft = stage2Draft(want);
    const allConfirmed = body.stage1.months.every((x) => x.confirmed);
    const sources = Object.fromEntries([...keys].map((key) => [key, allConfirmed && body.stage2!.sources?.[key] === "auto" && draft.ok && draft.values[key] === values[key] ? ("auto" as const) : ("manual" as const)]));
    // ③ の下書きのままの欄は、本人が足す患者を確かめるまで結果を出さない（C-363）
    const unchecked = body.stage2.excludedChecked ? [] : [...keys].filter((key) => key.startsWith("excluded:") && sources[key] === "auto");
    return { stage1, stage2: { values, sources, unchecked } };
  }

  /** 結果を残す（追記）。空の欄があれば残さず 400 で名指しする。残せるのは事務長・責任者（権限表） */
  function saveWorksheet(user: Pick<User, "name">, body: Note14WorksheetBody) {
    const k = toolConstsAt(body.checkMonth);
    if (!k) throw badRequest(NOTE14_TOOL_TEXT.outOfScope, ["checkMonth"]);
    const input = inputOf(body, k);
    const p = periodOf(body.checkMonth, k);
    const e = evaluate(input, k, p);
    if (e.status === "incomplete") throw badRequest(`空の欄があります：${e.missing.join("、")}`, [e.stage2Open ? "stage2" : "stage1"]);
    const { outcomes, lines, reasons, remaining, stage2Open } = e;
    const info = ctx.sqlite
      .prepare("INSERT INTO note14_worksheets (check_month, period_3m_from, period_3m_to, period_12m_from, period_12m_to, inputs, outcomes, result, splits, checked_by, checked_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(body.checkMonth, p.short.from, p.short.to, p.long.from, p.long.to, JSON.stringify(input), JSON.stringify({ outcomes, lines, reasons, remaining, stage2Open }), e.result, JSON.stringify(e.splits), user.name, today(), new Date().toISOString());
    return view(readRows(ctx.sqlite).find((r) => r.id === Number(info.lastInsertRowid))!);
  }

  /**
   * 申告の下書き（GET /api/note14/worksheets/:id/draft）：meets → 通常、not_meets → 減算。いつの診療月からの初期値は確認月の翌月（EM U-28 の読み甲）。
   * 決めきれない・確認月以外の結果では作らない（409）。申告の行は書かない（申告の画面が値を入れた状態で開き、本人が確かめて残す。L-132）
   */
  function draftOf(id: number) {
    const r = readRows(ctx.sqlite).find((x) => x.id === id);
    if (!r) throw notFound("道具の結果がありません");
    const v = view(r);
    if (!v.draft) throw conflict(v.result === "undecided" ? "決めきれない結果からは、申告の下書きを作りません" : NOTE14_TOOL_TEXT.notCheckMonth);
    return { item: "note14" as const, choice: v.result === "meets" ? ("normal" as const) : ("reduced" as const), fromMonth: shiftMonth(r.check_month, 1), checkMonth: r.check_month, note: NOTE14_TOOL_TEXT.draftNote };
  }

  return { tool, saveWorksheet, draftOf };
}
