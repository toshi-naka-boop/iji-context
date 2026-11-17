// 分割した処理が共有するもの：SQLite・知識と記録の置き場所・config/ の設定・app_settings の読み書き
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { APP_MIGRATIONS, migrate } from "../../db/migrate";
import { ruleKubun } from "../../engine";
import type { Facility } from "../../engine/types";
import type { Calendar } from "../../lifecycle/calendar";
import type { ReviewDeps } from "../../lifecycle/review";
import type { BusinessDays, QueryLog } from "../../query/doctor-query";
import type { ChoiceGroup } from "../../practice/choice";

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

export const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

export function openContext(paths: AppPaths) {
  const sqlite = new Database(paths.dbFile);
  migrate(sqlite, APP_MIGRATIONS);
  const db = drizzle(sqlite);
  const store = { knowledgeDir: paths.knowledgeDir, skillsDir: paths.skillsDir };
  const queryLog: QueryLog = { dir: paths.queryLogDir };
  const cfg = (f: string) => path.join(paths.root, "config", f);
  const calendar = json<Calendar>(cfg("calendar.json"));
  const businessDays = json<BusinessDays>(cfg("business-days.json"));
  const levelCfg = json<{ thresholds: number[]; choiceWeight?: number }>(cfg("levels.json"));
  const levels = levelCfg.thresholds;
  const choiceGroups = json<{ groups: ChoiceGroup[] }>(cfg("choice-groups.json")).groups;
  const reviewCfg = json<{ meetingWeekday: number }>(cfg("review.json"));
  const facility = json<Facility>(cfg("facility.json"));
  const deps: ReviewDeps = { db, store, calendar, ruleKubun };

  const setting = (key: string): string | null =>
    (sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  const setSetting = (key: string, value: string) =>
    sqlite.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

  return { paths, sqlite, db, store, queryLog, businessDays, levelCfg, levels, choiceGroups, reviewCfg, facility, deps, setting, setSetting };
}

export type AppContext = ReturnType<typeof openContext>;
