// 時計（デモでは「時計を進める」で動く）
import { dueMeeting, meetingReview } from "../../lifecycle/review";
import { assertTime } from "../../lifecycle/time";
import { tickQueries } from "../../query/doctor-query";
import type { AppContext } from "./context";

/** デモの時計の初期値（合成レセプトの診療年月の中） */
export const DEFAULT_NOW = "2025-03-10T09:00:00+09:00";

export function createClock(ctx: AppContext) {
  const { sqlite, queryLog, businessDays, reviewCfg, deps, setting, setSetting } = ctx;

  function now(): string {
    return setting("now") ?? DEFAULT_NOW;
  }

  /** 時計を進める。医師確認のリマインド・保留と、会議の日を過ぎていればレセメン会議の整理を回す */
  function advanceClock(to: string) {
    assertTime(to, "now");
    setSetting("now", to);
    const queries = tickQueries(queryLog, to, businessDays);
    const last = (sqlite.prepare("SELECT ran_at FROM reviews ORDER BY ran_at DESC LIMIT 1").get() as { ran_at: string } | undefined)?.ran_at ?? null;
    const meeting = dueMeeting(last, to, reviewCfg.meetingWeekday) ? meetingReview(deps, to) : null;
    return { now: to, queries, meeting };
  }

  return { now, advanceClock };
}

export type Clock = ReturnType<typeof createClock>;
