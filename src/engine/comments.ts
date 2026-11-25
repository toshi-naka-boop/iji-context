// 摘要欄の記載（design.md §11-13）：検証（R17）と、導出の「摘要欄に書くこと」が共有する部品。
// どの記載が要るかは版の表（Revision.comments。EM §2-10 表 1）で決まり、ここは表の読み方だけを持つ。文章（理由）の中身は読まない。LLM は使わない
import { billedOushinDays, billedVisitDays, kanriLines, overLimitVisitDays, sameDayPairs } from "./predicates";
import type { CommentRule, Revision } from "./revisions/types";
import { eventsOf, present } from "./rules/util";
import type { ClaimContext, FactKey } from "./types";

/** 摘要欄の記載の表と、条件を決める版の定数 */
export type CommentSpec = Pick<Revision, "consts" | "comments" | "commentCodes">;

/**
 * 年号区分（和暦の元号の数字。EM §2-10 表 3）→ 元年の前の年。1＝明治、2＝大正、3＝昭和、4＝平成、5＝令和。
 * 元号の境の日（その元号にない年月日）までは見ない
 */
const ERA_BASE: Record<string, number> = { "1": 1867, "2": 1911, "3": 1925, "4": 1988, "5": 2018 };
/** 和暦に直すのは令和の日付だけ（令和の初日＝ 2019年5月1日 以降） */
const REIWA = { era: "5", from: 20190501 };

/** 和暦の年月日 7 桁（GYYMMDD。半角）を "YYYY-MM-DD" に直す。暦にない日・形の違う値は null */
export function dateOfWareki(text: string): string | null {
  const m = /^([1-5])(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (!m || m[2] === "00") return null;
  const iso = `${ERA_BASE[m[1]] + Number(m[2])}-${m[3]}-${m[4]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** "YYYY-MM-DD" を和暦の年月日 7 桁（半角）にする。令和より前の日付は null */
export function warekiOf(date: string): string | null {
  if (Number(date.replaceAll("-", "")) < REIWA.from) return null;
  return `${REIWA.era}${String(Number(date.slice(0, 4)) - ERA_BASE[REIWA.era]).padStart(2, "0")}${date.slice(5, 7)}${date.slice(8, 10)}`;
}

/**
 * コメントの文字データ（半角に寄せたもの）が、コードの形式に合うか。形式はコードの先頭 3 桁で決まる（EM §2-10 表 3）。
 * 見るのは表 1 のコードが使う形式と、G07 が見る 852（design.md §17-3）：830＝文字がある／842＝数値／850＝和暦の年月日 7 桁／851＝時刻 4 桁／852＝時間（分）5 桁。820 は文字データを持たないので見ない
 */
export function commentFormatOk(code: string, text: string): boolean {
  switch (code.slice(0, 3)) {
    case "830":
      return text.trim() !== "";
    case "842":
      return /^[+-]?\d+(\.\d+)?$/.test(text);
    case "850":
      return dateOfWareki(text) !== null;
    case "851":
      return /^([01]\d|2[0-3])[0-5]\d$/.test(text);
    case "852":
      return /^\d{5}$/.test(text);
    default:
      return true;
  }
}

/**
 * その記載が要るか。times は要る数（0 は要らない。両方を算定した日の理由は、その日の数）。
 * 条件を決める事実が不明なら、次に確かめる事実を返す。週の上限を超える訪問は、R13 と同じ数え方（overLimitVisitDays）で見る
 */
export function commentWhen(rule: CommentRule, ctx: ClaimContext, spec: CommentSpec): { known: true; times: number } | { known: false; need: FactKey } {
  const yes = (times: number) => ({ known: true as const, times });
  switch (rule.when) {
    case "always":
      return yes(1);
    case "sameDayVisitAndOushin":
      return yes(sameDayPairs(ctx, spec.consts).length);
    case "acuteOver3PerWeek": {
      if (overLimitVisitDays(ctx, spec.consts).length === 0) return yes(0);
      // 別表第七に当たる患者は、理由の記載の対象ではない（急性増悪は聞かない）
      const t7 = ctx.facts.table7;
      if (t7.known && t7.value) return yes(0);
      if (!t7.known) return { known: false, need: "table7" };
      const acute = ctx.facts.acuteExacerbation;
      return acute.known ? yes(acute.value ? 1 : 0) : { known: false, need: "acuteExacerbation" };
    }
    case "deathNotAtHome": {
      const place = ctx.facts.deathPlace;
      if (!place.known) return { known: false, need: "deathPlace" };
      return yes(place.value !== null && place.value !== "在宅" ? 1 : 0);
    }
  }
}

/** その請求で使うコード。族の決まったコード（在医総管用・施設総管用）は、算定している管理料の族に合うものだけ。管理料の行がなければ絞らない */
export function commentCodesFor(rule: CommentRule, ctx: ClaimContext, spec: CommentSpec): string[] {
  const families = new Set(kanriLines(ctx, spec.consts).map((l) => l.family));
  const hit = rule.codes.filter((code) => {
    const family = spec.commentCodes[code]?.family;
    return family === undefined || families.has(family);
  });
  return hit.length > 0 ? hit : rule.codes;
}

/** 訪問診療料か往診料を算定した日（重複は除いて昇順）。「往診又は訪問診療を行った年月日」の記載と突き合わせる */
export function visitOrOushinDays(ctx: ClaimContext, spec: CommentSpec): string[] {
  return [...new Set([...billedVisitDays(ctx, spec.consts), ...billedOushinDays(ctx, spec.consts)])].sort();
}

/** 管理料の算定開始月（"YYYY-MM"。記録になければ undefined）。在宅移行早期加算（ikouEligible）と同じく、最も新しいものを採る */
export const kanriStartMonth = (ctx: ClaimContext): string | undefined => eventsOf(ctx, "kanriStart").map((e) => e.month).sort().at(-1);

/**
 * 摘要欄に書くこと 1 件。kubun は、その記載が付く行の区分。
 * ready＝値まで決まった（text は半角。年月日は和暦 7 桁。文字データを持たないコードは空文字）／needsInput＝人が入れる（code が null なら、コードも選ぶ）
 */
export type RequiredComment = { rule: string; kubun: string; code: string | null; text: string | null; status: "ready" | "needsInput" };

/**
 * 行・事実・出来事から、摘要欄に書くことを作る（導出の comments。同梱の UKE のコメントも、これで作る）。
 * 値を決められるものは埋める：年月日は行の日付・出来事の日付から、包括的支援加算の状態は要介護度か障害支援区分が対象と分かっているときだけ。
 * 決められないもの（理由の文、検査値、時刻、記録にない日付）は needsInput にする。条件を決める事実が不明の記載は出さない（R17 が情報不足を返す）
 */
export function requiredComments(ctx: ClaimContext, spec: CommentSpec): RequiredComment[] {
  const out: RequiredComment[] = [];
  for (const rule of spec.comments) {
    const kubun = present(ctx, rule.kubun)[0];
    if (kubun === undefined) continue;
    const when = commentWhen(rule, ctx, spec);
    if (when.known === false || when.times === 0) continue;
    const codes = commentCodesFor(rule, ctx, spec);
    const ready = (code: string, text: string) => out.push({ rule: rule.id, kubun, code, text, status: "ready" });
    const input = (code: string | null) => out.push({ rule: rule.id, kubun, code, text: null, status: "needsInput" });
    const dated = (code: string, date: string | undefined) => {
      const text = date === undefined ? null : warekiOf(date);
      if (text === null) input(code);
      else ready(code, text);
    };
    /** コードが 1 つに決まるならそのコード、選ぶものなら null */
    const only = codes.length === 1 ? codes[0] : null;
    switch (rule.compare) {
      case "visitDates":
        for (const d of visitOrOushinDays(ctx, spec)) dated(codes[0], d);
        break;
      case "hokatsuState": {
        const care = ctx.facts.careLevel;
        const disability = ctx.facts.disabilitySupportLevel;
        const code =
          (care.known ? codes.find((x) => spec.commentCodes[x]?.careLevel === care.value) : undefined) ??
          codes.find((x) => {
            const min = spec.commentCodes[x]?.disabilityLevelMin;
            return min !== undefined && disability.known && disability.value >= min;
          });
        if (code === undefined) input(null);
        else ready(code, "");
        break;
      }
      case "ikouStart": {
        // 算定開始月が当月なら、初回は当月の管理料の行の日。前の月の日は、記録にないので人が入れる
        const first = kanriStartMonth(ctx) === ctx.yearMonth ? kanriLines(ctx, spec.consts).flatMap((l) => ctx.lines.find((x) => x.kubun === l.kubun && x.count > 0)?.dates ?? []).sort()[0] : undefined;
        if (only === null) input(null);
        else dated(only, first);
        break;
      }
      case "deathDate":
        for (const code of codes) dated(code, eventsOf(ctx, "death")[0]?.date);
        break;
      case "acuteVisitDates":
        for (const code of codes) {
          if (spec.commentCodes[code]?.visited) for (const d of overLimitVisitDays(ctx, spec.consts)) dated(code, d);
          else input(code);
        }
        break;
      default:
        if (rule.need === "each") for (let i = 0; i < when.times; i++) for (const code of codes) input(code);
        else input(only);
    }
  }
  return out;
}
