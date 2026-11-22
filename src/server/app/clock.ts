// 時計。デモのクリニックは「時計を進める」で動く。実在のデータで使うクリニック（real）と未定のクリニックは実際の日付（日本時間）で動き、進められない
import { period } from "../../demo/period";
import { dueMeeting, latestReview, meetingReview } from "../../lifecycle/review";
import { assertTime } from "../../lifecycle/time";
import { tickQueries } from "../../query/doctor-query";
import { forbidden } from "../errors";
import type { AppContext } from "./context";

/** デモの時計の初期値（合成レセプトの診療年月の中） */
export const DEFAULT_NOW = period.clockStart;

const JST = 9 * 3_600_000;
/** 実際の時刻を、日本時間のタイムゾーン付き ISO 8601 にする（例 2026-11-22T14:05:33+09:00。design.md §3 の時刻の形式） */
export const jstIsoOf = (d: Date): string => `${new Date(d.getTime() + JST).toISOString().slice(0, 19)}+09:00`;
/** 時刻の、日本時間の日付（YYYY-MM-DD） */
const jstDayOf = (s: string): string => new Date(Date.parse(s) + JST).toISOString().slice(0, 10);

/** 実在のクリニックで、日付が変わったときに回した日時（app_settings のキー） */
const CAUGHT_UP_KEY = "caught_up_at";
/** 日付が変わったときの処理が続けて失敗したときの、回し直す間隔（最初の間隔と上限。設計パラメータ） */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

export function createClock(ctx: AppContext) {
  const { kind, queryLog, businessDays, reviewCfg, deps, setting, setSetting } = ctx;

  /** 今日。demo はデモの時計（設定がなければ基準月の初期値）。real と未定は実際の時刻（デモの時計の設定を読まない） */
  function now(): string {
    if (kind !== "demo") return jstIsoOf(new Date());
    return setting("now") ?? DEFAULT_NOW;
  }

  /**
   * 時が進んだときの処理：医師確認のリマインド・保留と、会議の日を過ぎていればレセメン会議の整理（トリガーの評価を含む）。
   * どれも、同じ日時でやり直しても同じ結果になる
   */
  function tick(to: string) {
    const queries = tickQueries(queryLog, to, businessDays);
    // 前回の整理（real・未定では、選んだ日時より後で今より前のものだけ。context.ts の validReview）
    const last = latestReview(deps)?.ranAt ?? null;
    const meeting = dueMeeting(last, to, reviewCfg.meetingWeekday) ? meetingReview(deps, to) : null;
    return { queries, meeting };
  }

  /**
   * 時計を進める（demo のクリニックだけ）。医師確認のリマインド・保留と、会議の日を過ぎていればレセメン会議の整理を回す。
   * 医師確認の記録と知識はファイルに書くので、DB のトランザクション 1 つにはまとめられない。失敗しうる処理を先に回し、時計の保存を最後にする
   * （途中で失敗したら時計は進まない。リマインド・保留と会議の整理は、同じ日時でやり直しても同じ結果になる）
   */
  function advanceClock(to: string) {
    if (kind !== "demo") throw forbidden("このクリニックでは日付を進められません（今日は実際の日付です。日付を進められるのは、デモで試すクリニックだけです）");
    assertTime(to, "now");
    const r = tick(to);
    setSetting("now", to);
    return { now: to, ...r };
  }

  /**
   * 続けて失敗した回数と、次に回してよい時刻（このプロセスの中だけ）。1 回目の失敗のあとは次のリクエストですぐ回し直す（一時的な失敗を同じ日のうちに取り戻す）。
   * 2 回以上続けて失敗したら、1 分・2 分・4 分…と間隔を空け、30 分を上限にする（失敗が続くときに、毎リクエストで重い処理を回さない）。回せたら元に戻す
   */
  let failures = 0;
  let retryAt = 0;
  /**
   * real のクリニックで、前に回した日から日付（日本時間）が変わっていれば、今の時刻で tick を回す（リクエストのたびに呼ぶ。src/server/instance.ts）。
   * 回した日時は DB（app_settings）に残す。同じ日のうちは何もしない（重い処理を毎リクエストで回さない）。回したら結果を、回さなければ null を返す。
   * 失敗したら回した日時を残さず、上の間隔で回し直す。
   * demo のクリニックでは何もしない（時計を進めたときに advanceClock が回す）。未定のクリニックでも何もしない（使い方を選ぶまで、記録に触らない）
   */
  function catchUp(): ReturnType<typeof tick> | null {
    if (kind !== "real") return null;
    const at = now();
    const last = setting(CAUGHT_UP_KEY);
    if ((last !== null && jstDayOf(last) >= jstDayOf(at)) || Date.now() < retryAt) return null;
    try {
      const r = tick(at);
      setSetting(CAUGHT_UP_KEY, at);
      failures = 0;
      retryAt = 0;
      return r;
    } catch (e) {
      failures += 1;
      retryAt = failures >= 2 ? Date.now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 2), RETRY_MAX_MS) : 0;
      throw e;
    }
  }

  return { now, advanceClock, catchUp };
}

export type Clock = ReturnType<typeof createClock>;
