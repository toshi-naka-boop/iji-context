// 略語の医師への確認（spec FR-211。design/iji-context/plan-fr211.md の「何を作るか」4・5）。医師確認の「確かめてほしい項目」（FR-174）に足す問い。
// 問いは定型文 1 つ、選択肢は固定の 4 つ（LLM に作らせない。この機能に LLM の呼び出しはない）。医師確認の 7 要件（FR-30）：
// ①引用（カルテの日付と文）②定型文で誘導しない ③「その他」「判定不能」④点数・金額の語を出さない（引用の該当の語は伏せる）⑤validateQuery と同じ検査 ⑥答えを追記で残す ⑦営業日でリマインド・保留の印。
// まとめ：答えの付いていない記載を（診療年月・語）で束ねて 1 問。「記載によって違う」の答えが付いた記載は、記載 1 つずつの問いに割る。
// 答えは、答えた時点で並んでいた記載にだけ効く（あとから同じ月に増えた記載は新しい問い）。答えはクリニックごとに覚えず、翌月の同じ語は改めて聞く。
// 患者の氏名・患者 id は持たない・返さない（請求の番号と日付だけ）。ログ・監査ログに引用と答えの文を出さない
import type Database from "better-sqlite3";
import { askedItems, type AbbrevItem } from "../../chart/abbrev";
import type { AbbrevState, StoredActs } from "../../chart/acts";
import type { ExtractedFact } from "../../chart/extract";
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
  since: string;
  reminded: boolean;
  held: boolean;
};

const refOf = (noteId: number, place: string, key: string) => `${noteId}:${place}:${key}`;
const REF = /^([1-9][0-9]{0,9}):(act|child|fact):([0-9a-f]{16})$/;

/** 引用を語を含む文 1 つに切り、点数・金額の語（MONEY の正規表現そのもの）を伏せる */
export function quoteOf(quote: string, token: string): { quote: string; masked: boolean } {
  const sentences = quote.split(/(?<=[。\n])/).map((x) => x.trim()).filter(Boolean);
  const one = sentences.find((x) => x.normalize("NFKC").includes(token)) ?? quote.trim();
  const money = new RegExp(MONEY.source, "g");
  const masked = one.replace(money, MASK);
  return { quote: masked, masked: masked !== one };
}

/** そのカルテの答えの記録を消す（カルテを消すとき。答えの記載が 1 つも残らない答えも消す。FR-168 の全表走査） */
export function forgetAbbrevAnswers(sqlite: Database.Database, noteIds: number[]): void {
  if (noteIds.length === 0) return;
  sqlite.prepare(`DELETE FROM abbrev_answer_items WHERE note_id IN (${noteIds.map(() => "?").join(", ")})`).run(...noteIds);
  sqlite.prepare("DELETE FROM abbrev_answers WHERE id NOT IN (SELECT answer_id FROM abbrev_answer_items)").run();
}

type Item = AbbrevItem & { noteId: number; claimId: string; date: string; yearMonth: string; at: string; ref: string };
type Answer = { id: number; option: string; freeText: string | null };

export function createDoctorAbbrevs(ctx: Pick<AppContext, "sqlite" | "hiddenClaim" | "businessDays">, clock: Pick<Clock, "now">, clerks: Pick<Clerks, "clerk">, yearMonthOf: (claimId: string) => string) {
  const { sqlite } = ctx;

  /** 保存したカルテの、医師に聞く記載（見本の請求は demo 以外のクリニックでは出さない） */
  function items(): Item[] {
    const rows = sqlite.prepare("SELECT id, claim_id, date, kind, facts, acts, created_at FROM chart_notes WHERE facts IS NOT NULL OR acts IS NOT NULL ORDER BY id").all() as {
      id: number;
      claim_id: string;
      date: string;
      kind: string;
      facts: string | null;
      acts: string | null;
      created_at: string;
    }[];
    return rows.flatMap((r) => {
      if (ctx.hiddenClaim(r.claim_id)) return [];
      const stored = r.acts === null ? null : (JSON.parse(r.acts) as StoredActs);
      const found = askedItems(r.kind, stored, r.facts === null ? null : (JSON.parse(r.facts) as ExtractedFact[]));
      if (found.length === 0) return [];
      let yearMonth: string;
      try {
        yearMonth = yearMonthOf(r.claim_id);
      } catch {
        return [];
      }
      const at = stored?.abbrev?.at ?? r.created_at;
      return found.map((x) => ({ ...x, noteId: r.id, claimId: r.claim_id, date: r.date, yearMonth, at, ref: refOf(r.id, x.place, x.key) }));
    });
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
    const make = (yearMonth: string, token: string, list: Item[], split: boolean): AbbrevRequest => {
      const quotes = list
        .map((it) => ({ ref: it.ref, claimId: it.claimId, date: it.date, ...quoteOf(it.quote, token) }))
        .sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const since = list.map((x) => x.at).sort()[0];
      const n = businessDaysElapsed(since, now, ctx.businessDays);
      return { yearMonth, token, question: abbrevQuestion(token), options: [...ABBREV_OPTIONS], quotes, split, since, reminded: n >= 1, held: n >= 3 };
    };
    const out = [...groups.entries()].map(([k, list]) => {
      const [yearMonth, token] = [k.slice(0, 7), k.slice(8)];
      return make(yearMonth, token, list, false);
    });
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
    })();
    return doctorAbbrevs();
  }

  /** 記載 1 つの、語ごとのいちばん新しい答え（答えのない語は含めない） */
  function answersOf(noteId: number, place: AbbrevItem["place"], key: string, tokens: string[]): { token: string; answer: Answer }[] {
    const ans = latest();
    return tokens.flatMap((token) => {
      const a = ans.get(`${refOf(noteId, place, key)}|${token}`);
      return a ? [{ token, answer: a }] : [];
    });
  }
  /** 記載 1 つの状態：答えのない語か「記載によって違う」の語があれば確かめ中。全部答えがあり、判定不能・その他があれば unresolved */
  function stateOf(noteId: number, place: AbbrevItem["place"], key: string, tokens: string[]): AbbrevState {
    const got = answersOf(noteId, place, key, tokens);
    if (got.length < tokens.length || got.some((x) => x.answer.option === ABBREV_VARIES)) return "asking";
    return got.some((x) => x.answer.option === OTHER || x.answer.option === UNDETERMINABLE) ? "unresolved" : "answered";
  }
  /** 記載 1 つに効く「指すものを記入する」の答えの語（候補を作るときだけ lookup の語として使う。自動では当てない） */
  const writtenIn = (noteId: number, place: AbbrevItem["place"], key: string, tokens: string[]): string[] =>
    answersOf(noteId, place, key, tokens).flatMap((x) => (x.answer.option === ABBREV_WRITE_IN && x.answer.freeText ? [x.answer.freeText] : []));

  return { doctorAbbrevs, answerDoctorAbbrev, stateOf, writtenIn, answersOf };
}

export type DoctorAbbrevs = ReturnType<typeof createDoctorAbbrevs>;

/** 問いが 7 要件のうち規則で確かめられるもの（①②③④）を満たすか（validateQuery と同じ検査。⑤。テストで縛る） */
export const abbrevQueryErrors = (q: Pick<AbbrevRequest, "question" | "options" | "quotes" | "yearMonth">): string[] =>
  validateQuery({ question: q.question, options: q.options, indicators: q.quotes.map((x) => ({ source: `カルテ ${x.date}（${x.claimId}）`, text: x.quote })) });
