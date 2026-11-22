// 分割した処理が共有するもの：SQLite・知識と記録の置き場所・config/ の設定・app_settings の読み書き
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { APP_MIGRATIONS, migrate } from "../../db/migrate";
import { ruleKubun } from "../../engine";
import { isKnownKubun } from "../../engine/revisions";
import { hasRevision } from "../../engine/revisions";
import type { FacilityJson } from "../../engine/facility";
import type { Calendar } from "../../lifecycle/calendar";
import type { ReviewDeps } from "../../lifecycle/review";
import type { StoreOptions } from "../../lifecycle/store";
import type { BusinessDays, QueryLog } from "../../query/doctor-query";
import type { ChoiceGroup } from "../../practice/choice";
import { officialInputOf } from "../../official/registry";
import { checkDataset } from "../dataset";
import type { TenantStatus } from "../tenant-kind";
import { isSampleClaim, isSampleKnowledge } from "../sample-data";

export type AppPaths = { root: string; dbFile: string; knowledgeDir: string; skillsDir: string; queryLogDir: string };

export function defaultPaths(root = process.cwd()): AppPaths {
  return {
    root,
    dbFile: path.join(root, "data", "resemen.db"),
    knowledgeDir: path.join(root, "knowledge"),
    skillsDir: path.join(root, ".claude", "skills"),
    queryLogDir: path.join(root, "query-log"),
  };
}

/** 本番の配線が作る ReviewDeps。版の有無（hasRevision）を必ず渡す（渡し忘れると、版のない提出で会議の整理が止まる） */
export function reviewDepsOf(base: Pick<ReviewDeps, "db" | "store" | "calendar" | "official">): ReviewDeps {
  return { ...base, ruleKubun: (ruleId, yearMonth) => ruleKubun(ruleId, yearMonth), hasRevision: (yearMonth) => hasRevision(yearMonth) };
}

/**
 * 本番の配線が作る StoreOptions。区分のキーの検査（同梱の版の点数表にあるか）を必ず渡す（design.md §3）。
 * demo 以外のクリニック（real・未定）では、同梱の作り物から生まれた知識（src/server/sample-data.ts）を、判断・会議・トリガー・Skill から外す
 */
export function storeOptionsOf(paths: Pick<AppPaths, "knowledgeDir" | "skillsDir">, kind: TenantStatus = "demo"): StoreOptions {
  return { knowledgeDir: paths.knowledgeDir, skillsDir: paths.skillsDir, knownKubun: isKnownKubun, ...(kind === "demo" ? {} : { excluded: isSampleKnowledge }) };
}

export const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

/**
 * kind はクリニックの種類（src/server/tenant-kind.ts）。ログインなしの既定のアプリと、種類を渡さない呼び出し（テスト）は demo。
 * 未定（undecided）は、作り物と時計について real と同じ側に倒す（demo のときだけ作り物とデモの時計を使う）
 */
export function openContext(paths: AppPaths, opts: { kind?: TenantStatus } = {}) {
  const kind: TenantStatus = opts.kind ?? "demo";
  const fresh = !existsSync(paths.dbFile);
  const sqlite = new Database(paths.dbFile);
  migrate(sqlite, APP_MIGRATIONS);
  // データの版の印：新しい置き場には今の印を付け、印が違う置き場は警告を記録して開く（止めない・作り直さない）
  const dataset = checkDataset(sqlite, fresh);
  const db = drizzle(sqlite);
  const store = storeOptionsOf(paths, kind);
  const queryLog: QueryLog = { dir: paths.queryLogDir };
  const cfg = (f: string) => path.join(paths.root, "config", f);
  const calendar = json<Calendar>(cfg("calendar.json"));
  const businessDays = json<BusinessDays>(cfg("business-days.json"));
  const levelCfg = json<{ thresholds: number[]; choiceWeight?: number }>(cfg("levels.json"));
  const levels = levelCfg.thresholds;
  const choiceGroups = json<{ groups: ChoiceGroup[] }>(cfg("choice-groups.json")).groups;
  const reviewCfg = json<{ meetingWeekday: number }>(cfg("review.json"));
  // 既定の施設の設定（JSON の形のまま持つ。症例ごとの上書きを重ねて三値に変えるのは src/server/app/cases.ts の 1 か所）
  const facility = json<FacilityJson>(cfg("facility.json"));
  // 公的情報レジストリ（official/）。形の違う文書があれば起動を止める。会議の整理（トリガー④）とローカルルール欄が同じものを使う
  const official = officialInputOf(paths.root);
  const deps = reviewDepsOf({ db, store, calendar, official });

  const setting = (key: string): string | null =>
    (sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  const setSetting = (key: string, value: string) =>
    sqlite.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

  /**
   * この請求を指す記録を、一覧・会議・点検に出さないか：demo 以外（real・未定）のクリニックで、同梱の見本の請求（K…）を指すもの。
   * デモのときに作った問題・医師確認・訪問カルテ・ベテランへの問い・提出を、消さずに残して見せない（2026-11-22 利用者の判断）
   */
  const hiddenClaim = (claimId: string | null | undefined): boolean => kind !== "demo" && !!claimId && isSampleClaim(claimId);

  return { kind, hiddenClaim, paths, sqlite, db, store, queryLog, businessDays, levelCfg, levels, choiceGroups, reviewCfg, facility, official, deps, dataset, setting, setSetting };
}

export type AppContext = ReturnType<typeof openContext>;
