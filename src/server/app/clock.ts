// 時計。デモのクリニックは「時計を進める」で動く。実在のデータで使うクリニック（real）は実際の日付（日本時間）で動き、進められない
import { period } from "../../demo/period";
import { dueMeeting, meetingReview } from "../../lifecycle/review";
import { assertTime } from "../../lifecycle/time";
import { tickQueries } from "../../query/doctor-query";
import { forbidden } from "../errors";
import type { AppContext } from "./context";

/** デモの時計の初期値（合成レセプトの診療年月の中） */
export const DEFAULT_NOW = period.clockStart;

const JST = 9 * 3_600_000;
/** 実際の時刻を、日本時間のタイムゾーン付き ISO 8601 にする（例 2026-11-22T14:05:33+09:00。design.md §3 の時刻の形式） */
export const jstIsoOf = (d: Date): string => `${new Date(d.getTime() + JST).toISOString().slice(0, 19)}+09:00`;

export function createClock(ctx: AppContext) {
  const { kind, sqlite, queryLog, businessDays, reviewCfg, deps, setting, setSetting } = ctx;

  /** 今日。real は実際の時刻（デモの時計の設定を読まない）。demo はデモの時計（設定がなければ基準月の初期値） */
  function now(): string {
    if (kind === "real") return jstIsoOf(new Date());
    return setting("now") ?? DEFAULT_NOW;
  }

  /**
   * 時が進んだときの処理：医師確認のリマインド・保留と、会議の日を過ぎていればレセメン会議の整理（トリガーの評価を含む）。
   * どれも、同じ日時でやり直しても同じ結果になる
   */
  function tick(to: string) {
    const queries = tickQueries(queryLog, to, businessDays);
    const last = (sqlite.prepare("SELECT ran_at FROM reviews ORDER BY ran_at DESC LIMIT 1").get() as { ran_at: string } | undefined)?.ran_at ?? null;
    const meeting = dueMeeting(last, to, reviewCfg.meetingWeekday) ? meetingReview(deps, to) : null;
    return { queries, meeting };
  }

  /**
   * 時計を進める（demo のクリニックだけ）。医師確認のリマインド・保留と、会議の日を過ぎていればレセメン会議の整理を回す。
   * 医師確認の記録と知識はファイルに書くので、DB のトランザクション 1 つにはまとめられない。失敗しうる処理を先に回し、時計の保存を最後にする
   * （途中で失敗したら時計は進まない。リマインド・保留と会議の整理は、同じ日時でやり直しても同じ結果になる）
   */
  function advanceClock(to: string) {
    if (kind === "real") throw forbidden("実在のデータで使うクリニックでは、日付を進められません（今日は実際の日付です）");
    assertTime(to, "now");
    const r = tick(to);
    setSetting("now", to);
    return { now: to, ...r };
  }

  return { now, advanceClock };
}

export type Clock = ReturnType<typeof createClock>;
