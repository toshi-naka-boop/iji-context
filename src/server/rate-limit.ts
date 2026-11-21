// 回数制限（spec FR-139）：LLM・音声・UKE のアップロードのルートは、利用者ごとの 1 分あたりの回数と、1 日の上限を持つ。上限値は config/limits.json。
// LLM・音声は、サーバー全体の 1 日の上限（perDayAll）も持つ。全体の数は auth.db の rate_daily に置く（spec U-W。2026-11-21）
// 1 分あたりはプロセスの中で数え（Throttle）、1 日の数は tenant の app.db（rate_daily）に置いて再起動で消えないようにする。
// 接続元の IP は、前段の Caddy が付けた値だけを信用する（clientIp）
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Throttle } from "./auth";
import { UserError } from "./errors";

export type LimitName = "llm" | "voice" | "upload";
export type Limits = Record<LimitName, { perMinute: number; perDay: number; perDayAll?: number }> & { jsonBytes: number };

let cached: Limits | null = null;
export function limits(): Limits {
  cached ??= JSON.parse(readFileSync(path.join(process.cwd(), "config", "limits.json"), "utf8")) as Limits;
  return cached;
}

/** 1 日の区切りは日本時間の日付（実時刻。デモの時計は本人が動かせるので使わない） */
export const jstDay = (now: Date) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 1 日の回数（tenant の DB）。hit は数を 1 増やして、増やしたあとの数を返す */
export function createDailyCounter(sqlite: Database.Database) {
  function hit(bucket: string, userId: string, now = new Date()): number {
    return (
      sqlite
        .prepare("INSERT INTO rate_daily (day, bucket, user_id, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, bucket, user_id) DO UPDATE SET count = count + 1 RETURNING count")
        .get(jstDay(now), bucket, userId) as { count: number }
    ).count;
  }
  const count = (bucket: string, userId: string, now = new Date()) =>
    (sqlite.prepare("SELECT count FROM rate_daily WHERE day = ? AND bucket = ? AND user_id = ?").get(jstDay(now), bucket, userId) as { count: number } | undefined)?.count ?? 0;
  return { hit, count };
}
export type DailyCounter = ReturnType<typeof createDailyCounter>;

const perMinute = new Map<LimitName, Throttle>();

/**
 * 上限を超えていたら 429 の UserError。超えていなければ 1 回と数える（失敗した呼び出しも数える。費用は呼んだ時点でかかるため）。
 * key は利用者ごと（tenant と利用者 id）。all はサーバー全体の数（auth.db。src/server/auth.ts の dailyAll）
 */
export function enforceLimit(name: LimitName, key: string, userId: string, daily: DailyCounter, now = new Date(), cfg = limits()[name], all?: DailyCounter) {
  let t = perMinute.get(name);
  if (!t) perMinute.set(name, (t = new Throttle(cfg.perMinute, 60_000)));
  if (t.blocked(key, now.getTime())) throw new UserError(429, "続けて呼びすぎています。1 分ほど待ってからもう一度試してください");
  if (daily.count(name, userId, now) >= cfg.perDay) throw new UserError(429, "今日の上限に達しました。明日もう一度試してください");
  // サーバー全体の上限（perDayAll がある種類だけ）。全員の数なので、誰の呼び出しかは数に入れない
  if (all && cfg.perDayAll !== undefined && all.count(name, "*", now) >= cfg.perDayAll) throw new UserError(429, "今日のサーバー全体の上限に達しました。明日もう一度試すか、管理者に知らせてください");
  t.hit(key, now.getTime());
  daily.hit(name, userId, now);
  if (all && cfg.perDayAll !== undefined) all.hit(name, "*", now);
}

/** テスト用：プロセスの中の数をリセットする */
export const resetLimits = () => perMinute.clear();

/**
 * 接続元の IP。前段の Caddy が付ける X-Real-IP だけを使う（deploy/Caddyfile で、利用者が送ってきた値を上書きしている）。
 * Caddy の後ろにいると明示したとき（RESEMEN_TRUST_PROXY=1。deploy/docker-compose.yml）だけ読み、
 * 直結のとき（手元の開発など）はヘッダを信用しない。x-forwarded-for の先頭は利用者が好きに書けるので使わない
 */
export function clientIp(req: Request): string {
  if (process.env.RESEMEN_TRUST_PROXY !== "1") return "direct";
  const ip = req.headers.get("x-real-ip")?.trim();
  return ip && /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : "unknown";
}
