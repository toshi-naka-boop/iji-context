// 略語の医師への確認（spec FR-211。plan-fr211.md「辞書方式の決め」2〜5）。医師確認の「確かめてほしい項目」（FR-174）に足す問い。
// 事務がカルテの略語ごとに扱いを選び（辞書の意味・その他・判定不能／辞書にない略語は算定に関係なし・医師に聞く）、医師確認に回した略語だけを問いにする。
// 問いは定型文 1 つ、選択肢は固定の 4 つ（LLM に作らせない。この機能に LLM の呼び出しはない）。事務が選んだ意味は問いに出さない（誘導しない）。医師確認の 7 要件（FR-30）：
// ①引用（カルテの日付と、原文のその略語を含む文）②定型文で誘導しない ③「その他」「判定不能」④点数・金額の語を出さない（引用の該当の語は伏せる）⑤validateQuery と同じ検査 ⑥答えを追記で残す ⑦営業日でリマインド・保留の印。
// まとめ：同じ月・同じ略語で患者をまたいで 1 問（MAX_ABBREV_REFS を超えたら割る）。「記載によって違う」の答えが付いたカルテは 1 つずつの問いに割る。答えは答えた時点で並んでいたカルテにだけ効く。
// 医師が「指すものを記入する」で答えた意味が辞書にない（事務の選んだ意味と違う・辞書にない略語）ときは、クリニックの辞書に書き足す（決め 5。追記だけ）。次からは候補に出る。
// 答えを待つあいだも、カルテの確かめと月末の点検は止めない（決め 3。画面に「医師確認中」の札を出すだけ）。
// 患者の氏名・患者 id は持たない・返さない（請求の番号と日付だけ）。ログ・監査ログに引用と答えの文を出さない
import type Database from "better-sqlite3";
import { itemKeyOf, sentenceWith, type AbbrevItem } from "../../chart/abbrev";
import { candidatesOf, manbyoOf } from "../../chart/abbrev-dict";
import { withMasters } from "../../masters/db";
import type { ChartNote } from "../../chart/extract";
import { businessDaysElapsed, MONEY, OTHER, UNDETERMINABLE, validateQuery } from "../../query/doctor-query";
import { badRequest, conflict } from "../errors";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";

/** 選択肢（固定。画面に同じ大きさで並べる） */
export const ABBREV_WRITE_IN = "指すものを記入する";
export const ABBREV_VARIES = "記載によって違う";
export const ABBREV_OPTIONS = [ABBREV_WRITE_IN, ABBREV_VARIES, OTHER, UNDETERMINABLE] as const;
/** 問いの定型文 */
export const abbrevQuestion = (token: string): string => `この記載の『${token}』は何を指しますか`;
/** 記述の上限（記入は候補を引く語なので短く） */
export const MAX_ABBREV_WRITE_IN = 100;
export const MAX_ABBREV_OTHER = 200;
/** 1 問に並べる記載の上限（GET の問いと POST の答えで同じ値。超えたら問いを割る。反証 round-96 X-493） */
export const MAX_ABBREV_REFS = 500;
/** 伏せた語の印と、添える文 */
export const MASK = "＊＊";
export const MASKED_NOTE = "伏せた語があります";

/** 引用 1 つ。ref は記載の参照（カルテの id・場所・指紋）。答えるときに、見ていた記載としてそのまま返す */
export type AbbrevQuote = { ref: string; claimId: string; date: string; quote: string; masked: boolean };
/** 問い 1 つ。split は「記載によって違う」で割った問い。reminded・held は ⑦（最初の記載の確かめから 1 営業日・3 営業日。保存せず読むときに決める） */
export type AbbrevRequest = {
  yearMonth: string;
  token: string;
  question: string;
  options: string[];
  quotes: AbbrevQuote[];
  split: boolean;
  /** 辞書（万病辞書・クリニックの辞書）で意味が複数ある略語、または大文字小文字で別の意味になる略語か（問いの下に事実だけを添える。どの意味かは示さない） */
  multiMeaning: boolean;
  since: string;
  reminded: boolean;
  held: boolean;
};

const refOf = (noteId: number, place: string, key: string) => `${noteId}:${place}:${key}`;
const REF = /^([1-9][0-9]{0,9}):(text):([0-9a-f]{16})$/;

/** 引用（原文のその語を含む文。plan-fr211.md「規則の作り直し」2）を語を含む文 1 つに切り、点数・金額の語（MONEY の正規表現そのもの）を伏せる */
export function quoteOf(quote: string, token: string): { quote: string; masked: boolean } {
  const sentences = quote.split(/(?<=[。\n])/).map((x) => x.trim()).filter(Boolean);
  const one = sentences.find((x) => x.normalize("NFKC").includes(token)) ?? quote.trim();
  const money = new RegExp(MONEY.source, "g");
  const masked = one.replace(money, MASK);
  return { quote: masked, masked: masked !== one };
}

/** そのカルテの答えと、事務の選んだ扱いの記録を消す（カルテを消すとき。答えの記載が 1 つも残らない答えも消す。FR-168 の全表走査。クリニックの辞書は患者のデータではないので残す） */
export function forgetAbbrevAnswers(sqlite: Database.Database, noteIds: number[]): void {
  if (noteIds.length === 0) return;
  sqlite.prepare(`DELETE FROM abbrev_answer_items WHERE note_id IN (${noteIds.map(() => "?").join(", ")})`).run(...noteIds);
  sqlite.prepare("DELETE FROM abbrev_answers WHERE id NOT IN (SELECT answer_id FROM abbrev_answer_items)").run();
  // 事務がそのカルテの略語に選んだ扱い
  sqlite.prepare(`DELETE FROM abbrev_selections WHERE note_id IN (${noteIds.map(() => "?").join(", ")})`).run(...noteIds);
}

type Item = AbbrevItem & { noteId: number; claimId: string; date: string; yearMonth: string; at: string; ref: string; note: ChartNote };
type Answer = { id: number; option: string; freeText: string | null };
/** 事務がカルテの略語に選んだ扱い（いちばん新しい行。辞書方式の決め 2〜4） */
export type AbbrevSelection = { option: string; meaning: string | null; askDoctor: boolean; at: string };

export function createDoctorAbbrevs(ctx: Pick<AppContext, "sqlite" | "hiddenClaim" | "businessDays">, clock: Pick<Clock, "now">, clerks: Pick<Clerks, "clerk">, yearMonthOf: (claimId: string) => string) {
  const { sqlite } = ctx;

  /** カルテと略語ごとの、いちばん新しい選んだ扱い（鍵は「カルテの id|語」） */
  function selectionsAll(): Map<string, AbbrevSelection> {
    const out = new Map<string, AbbrevSelection>();
    for (const r of sqlite.prepare("SELECT note_id, token, option, meaning, ask_doctor, chosen_at FROM abbrev_selections ORDER BY id").all() as { note_id: number; token: string; option: string; meaning: string | null; ask_doctor: number; chosen_at: string }[])
      out.set(`${r.note_id}|${r.token}`, { option: r.option, meaning: r.meaning, askDoctor: r.ask_doctor === 1, at: r.chosen_at });
    return out;
  }
  /** そのカルテのその略語の扱い（選んでいなければ null） */
  const selectionOf = (noteId: number, token: string): AbbrevSelection | null => selectionsAll().get(`${noteId}|${token}`) ?? null;
  /** 選んだ扱いを追記で残す（検査は呼び出し側〔src/server/app/notes.ts の selectAbbrev〕で済ませる） */
  function saveSelection(clerkId: string, noteId: number, token: string, s: { option: string; meaning: string | null; askDoctor: boolean }): void {
    sqlite.prepare("INSERT INTO abbrev_selections (note_id, token, option, meaning, ask_doctor, chosen_by, chosen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(noteId, token, s.option, s.meaning, s.askDoctor ? 1 : 0, clerkId, clock.now());
  }
  /** クリニックの辞書の、その略語の意味（書き足した順。同じ意味は 1 回） */
  const clinicMeanings = (token: string): string[] => (sqlite.prepare("SELECT meaning FROM abbrev_dictionary WHERE token = ? GROUP BY meaning ORDER BY MIN(id)").all(token) as { meaning: string }[]).map((r) => r.meaning);

  /** クリニックの辞書にある略語 */
  const clinicTokens = (): string[] => (sqlite.prepare("SELECT DISTINCT token FROM abbrev_dictionary").all() as { token: string }[]).map((r) => r.token);
  /** 事務が医師確認に回した略語（カルテと語の組。見本の請求は demo 以外のクリニックでは出さない）。引用は原文のその語を含む文 */
  function items(): Item[] {
    const rows = sqlite.prepare("SELECT id, claim_id, date, note FROM chart_notes ORDER BY id").all() as { id: number; claim_id: string; date: string; note: string }[];
    const sel = selectionsAll();
    const months = new Map<string, string | null>();
    const monthOf = (claimId: string): string | null => {
      if (!months.has(claimId)) {
        try {
          months.set(claimId, yearMonthOf(claimId));
        } catch {
          months.set(claimId, null);
        }
      }
      return months.get(claimId)!;
    };
    const byNote = new Map<number, { token: string; s: AbbrevSelection }[]>();
    for (const [k, s] of sel) {
      if (!s.askDoctor) continue;
      const [id, token] = [Number(k.slice(0, k.indexOf("|"))), k.slice(k.indexOf("|") + 1)];
      byNote.set(id, [...(byNote.get(id) ?? []), { token, s }]);
    }
    return rows.flatMap((r) => {
      const asked = byNote.get(r.id);
      if (!asked || ctx.hiddenClaim(r.claim_id)) return [];
      const yearMonth = monthOf(r.claim_id);
      if (yearMonth === null) return [];
      const note = JSON.parse(r.note) as ChartNote;
      return asked.map(({ token, s }) => {
        const sentence = sentenceWith(note, token) ?? token;
        const key = itemKeyOf(token, sentence);
        return { place: "text" as const, index: -1, written: token, quote: sentence, tokens: [token], key, noteId: r.id, claimId: r.claim_id, date: r.date, yearMonth, at: s.at, ref: refOf(r.id, "text", key), note };
      });
    });
  }
  /** 医師確認中か：医師確認に回していて、答えがまだない（「記載によって違う」で割ったあとも、答えるまで確認中） */
  function doctorPending(noteId: number, token: string): boolean {
    const s = selectionOf(noteId, token);
    if (!s?.askDoctor) return false;
    const it = items().find((x) => x.noteId === noteId && x.tokens[0] === token);
    if (!it) return false;
    const a = latest().get(`${it.ref}|${token}`);
    return !a || a.option === ABBREV_VARIES;
  }

  /** 記載と語ごとの、いちばん新しい答え（鍵は「参照|語」） */
  function latest(): Map<string, Answer> {
    const rows = sqlite
      .prepare("SELECT a.id, a.token, a.option, a.free_text, i.note_id, i.place, i.item_key FROM abbrev_answer_items i JOIN abbrev_answers a ON a.id = i.answer_id ORDER BY a.id")
      .all() as { id: number; token: string; option: string; free_text: string | null; note_id: number; place: string; item_key: string }[];
    const out = new Map<string, Answer>();
    for (const r of rows) out.set(`${refOf(r.note_id, r.place, r.item_key)}|${r.token}`, { id: r.id, option: r.option, freeText: r.free_text });
    return out;
  }

  /** 問いの一覧（診療年月・語の順。割った問いは束ねた問いの後ろ） */
  function doctorAbbrevs(): AbbrevRequest[] {
    const ans = latest();
    const groups = new Map<string, Item[]>();
    const splits: { token: string; item: Item }[] = [];
    for (const it of items()) {
      for (const token of it.tokens) {
        const a = ans.get(`${it.ref}|${token}`);
        if (!a) groups.set(`${it.yearMonth}|${token}`, [...(groups.get(`${it.yearMonth}|${token}`) ?? []), it]);
        else if (a.option === ABBREV_VARIES) splits.push({ token, item: it });
      }
    }
    const now = clock.now();
    // 辞書で意味が複数ある略語・大文字小文字で別の意味になる略語（AF／Af）
    const manbyo = withMasters((db) => manbyoOf(db));
    const multi = new Map<string, boolean>();
    const multiOf = (token: string): boolean => {
      if (!multi.has(token)) {
        const many = candidatesOf(token, manbyo, clinicMeanings(token)).candidates.length > 1;
        const variant = [...(manbyo?.entries() ?? [])].some(([k, e]) => k !== token && k.toUpperCase() === token.toUpperCase() && e.meanings.length > 0) || clinicTokens().some((k) => k !== token && k.toUpperCase() === token.toUpperCase());
        multi.set(token, many || variant);
      }
      return multi.get(token)!;
    };
    /** 請求の番号・日付・記載の参照の順（問いを割る位置を GET と POST で同じにする） */
    const order = (a: { claimId: string; date: string; ref: string }, b: { claimId: string; date: string; ref: string }) =>
      a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
    const make = (yearMonth: string, token: string, list: Item[], split: boolean): AbbrevRequest => {
      const quotes = list.map((it) => ({ ref: it.ref, claimId: it.claimId, date: it.date, ...quoteOf(sentenceWith(it.note, token) ?? it.quote, token) })).sort(order);
      const since = list.map((x) => x.at).sort()[0];
      const n = businessDaysElapsed(since, now, ctx.businessDays);
      return { yearMonth, token, question: abbrevQuestion(token), options: [...ABBREV_OPTIONS], quotes, split, multiMeaning: multiOf(token), since, reminded: n >= 1, held: n >= 3 };
    };
    // 上限を超える組は、並べた順に上限ずつの問いに割る
    const out = [...groups.entries()].flatMap(([k, list]) => {
      const [yearMonth, token] = [k.slice(0, 7), k.slice(8)];
      const sorted = [...list].sort(order);
      const chunks: Item[][] = [];
      for (let i = 0; i < sorted.length; i += MAX_ABBREV_REFS) chunks.push(sorted.slice(i, i + MAX_ABBREV_REFS));
      return chunks.map((c) => make(yearMonth, token, c, false));
    });
    // 同じ月・同じ語の割った問いは、並べた順のまま（sort は安定）
    out.sort((a, b) => (a.yearMonth < b.yearMonth ? -1 : a.yearMonth > b.yearMonth ? 1 : a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
    return [...out, ...splits.map((s) => make(s.item.yearMonth, s.token, [s.item], true))];
  }

  /**
   * 答えを追記で残す（⑥）。refs は答えた時点で画面に並んでいた記載で、効くのはその記載だけ。
   * 並んでいた記載が今の問いと合わなければ 409（開き直してもらう）。「記入」「その他」は記述つき、「判定不能」「記載によって違う」は記述なし。
   * 記載が 1 つの問いには「記載によって違う」を選べない。返すのは、残したあとの一覧
   */
  function answerDoctorAbbrev(clerkId: string, input: { yearMonth: string; token: string; refs: string[]; option: string; freeText?: string }): AbbrevRequest[] {
    clerks.clerk(clerkId);
    if (!(ABBREV_OPTIONS as readonly string[]).includes(input.option)) throw badRequest("選択肢にない答えです", ["option"]);
    const text = input.freeText?.trim() ?? "";
    if (input.option === ABBREV_WRITE_IN && text === "") throw badRequest("指すものを記入してください", ["freeText"]);
    if (input.option === ABBREV_WRITE_IN && text.length > MAX_ABBREV_WRITE_IN) throw badRequest(`記入は ${MAX_ABBREV_WRITE_IN} 字までです`, ["freeText"]);
    if (input.option === OTHER && text === "") throw badRequest("「その他」は、具体的に書いてください", ["freeText"]);
    if ((input.option === UNDETERMINABLE || input.option === ABBREV_VARIES) && text !== "") throw badRequest(`「${input.option}」に、記述は付けません`, ["freeText"]);
    const refs = [...new Set(input.refs)];
    if (refs.length === 0 || refs.some((r) => !REF.test(r))) throw badRequest("記載の参照が正しくありません", ["refs"]);
    const q = doctorAbbrevs().find((x) => x.yearMonth === input.yearMonth && x.token === input.token && refs.every((r) => x.quotes.some((y) => y.ref === r)));
    if (!q) throw conflict("この問いの記載が変わりました。開き直してください");
    if (input.option === ABBREV_VARIES && refs.length < 2) throw badRequest("記載が 1 つのときは「記載によって違う」を選べません", ["option"]);
    sqlite.transaction(() => {
      const id = Number(
        sqlite
          .prepare("INSERT INTO abbrev_answers (year_month, token, option, free_text, answered_by, answered_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(input.yearMonth, input.token, input.option, input.option === ABBREV_WRITE_IN || input.option === OTHER ? text : null, clerkId, clock.now()).lastInsertRowid,
      );
      const ins = sqlite.prepare("INSERT INTO abbrev_answer_items (answer_id, note_id, place, item_key) VALUES (?, ?, ?, ?)");
      for (const r of refs) {
        const m = REF.exec(r)!;
        ins.run(id, Number(m[1]), m[2], m[3]);
      }
      // 辞書に書き足す（決め 5）：医師が記入した意味が、その略語の辞書の意味（万病辞書・クリニックの辞書）にないとき。医師の答えなので承認済みとして足す
      if (input.option === ABBREV_WRITE_IN) {
        const known = [...(withMasters((db) => manbyoOf(db))?.get(input.token)?.meanings ?? []), ...clinicMeanings(input.token)];
        if (!known.includes(text))
          sqlite.prepare("INSERT INTO abbrev_dictionary (token, meaning, added_by, added_at, question) VALUES (?, ?, ?, ?, ?)").run(input.token, text, clerkId, clock.now(), `${input.yearMonth}|${input.token}|${id}`);
      }
    })();
    return doctorAbbrevs();
  }

  return { doctorAbbrevs, answerDoctorAbbrev, selectionOf, saveSelection, clinicMeanings, doctorPending };
}

export type DoctorAbbrevs = ReturnType<typeof createDoctorAbbrevs>;

/** 問いが 7 要件のうち規則で確かめられるもの（①②③④）を満たすか（validateQuery と同じ検査。⑤。テストで縛る） */
export const abbrevQueryErrors = (q: Pick<AbbrevRequest, "question" | "options" | "quotes" | "yearMonth">): string[] =>
  validateQuery({ question: q.question, options: q.options, indicators: q.quotes.map((x) => ({ source: `カルテ ${x.date}（${x.claimId}）`, text: x.quote })) });
