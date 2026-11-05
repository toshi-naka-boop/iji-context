// 適用記録・提出結果・レセメン会議の表（design.md §4-4、v20）
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const submissions = sqliteTable("submissions", {
  submissionId: text("submission_id").primaryKey(),
  claimId: text("claim_id").notNull(),
  /** 診療年月（"YYYY-MM"） */
  yearMonth: text("year_month").notNull(),
  linesHash: text("lines_hash").notNull(),
  submittedAt: text("submitted_at").notNull(),
  superseded: integer("superseded", { mode: "boolean" }).notNull().default(false),
});

export const applications = sqliteTable(
  "applications",
  {
    submissionId: text("submission_id").notNull(),
    knowledgeId: text("knowledge_id").notNull(),
    rev: text("rev").notNull(),
    role: text("role", { enum: ["final", "avoided", "ignored"] }).notNull(),
    /** JSON 配列文字列。ignored のとき、外された kubunAll の区分 */
    removedKubun: text("removed_kubun").notNull().default("[]"),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.knowledgeId] })],
);

export const claimResults = sqliteTable("claim_results", {
  /** 受け取った順（「最後に採用した結果」を決める） */
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  resultId: text("result_id").notNull().unique(),
  submissionId: text("submission_id").notNull(),
  kind: text("kind", { enum: ["原審査", "保険者再審査", "縦覧点検", "突合点検", "資格"] }).notNull(),
  outcome: text("outcome", { enum: ["通過", "返戻", "査定"] }).notNull(),
  /** JSON 配列文字列 */
  kubun: text("kubun").notNull(),
  contentHash: text("content_hash").notNull(),
  /** 今有効な結果として採用したか（round-5 X-24） */
  adopted: integer("adopted", { mode: "boolean" }).notNull(),
  importedAt: text("imported_at").notNull(),
});

export const reviews = sqliteTable("reviews", {
  reviewId: text("review_id").primaryKey(),
  ranAt: text("ran_at").notNull(),
});

export const digestItems = sqliteTable("digest_items", {
  itemId: text("item_id").primaryKey(),
  /** 最後に載せた整理 */
  reviewId: text("review_id").notNull(),
  kind: text("kind", { enum: ["miss", "recheck", "ignored", "disposal"] }).notNull(),
  knowledgeId: text("knowledge_id").notNull(),
  /** ignored のみ */
  submissionId: text("submission_id"),
  /** JSON：整理時点の status・status_since・rev・basisDate */
  snapshot: text("snapshot").notNull(),
  /** JSON：まとめに添える理由 */
  reason: text("reason").notNull(),
  answer: integer("answer"),
  freeText: text("free_text"),
  answeredAt: text("answered_at"),
  applied: integer("applied", { mode: "boolean" }).notNull().default(false),
  stale: integer("stale", { mode: "boolean" }).notNull().default(false),
  /** ignored の回答 1（取り忘れ）を新人のメンターに渡した日時。拾い直しでも通知を失わない（round-11 X-45） */
  notifiedAt: text("notified_at"),
});

/** 上の表を作る DDL（テストとデモの初期化で使う） */
export const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS submissions (submission_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, year_month TEXT NOT NULL, lines_hash TEXT NOT NULL, submitted_at TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS applications (submission_id TEXT NOT NULL, knowledge_id TEXT NOT NULL, rev TEXT NOT NULL, role TEXT NOT NULL, removed_kubun TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (submission_id, knowledge_id));
CREATE TABLE IF NOT EXISTS claim_results (seq INTEGER PRIMARY KEY AUTOINCREMENT, result_id TEXT NOT NULL UNIQUE, submission_id TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, kubun TEXT NOT NULL, content_hash TEXT NOT NULL, adopted INTEGER NOT NULL, imported_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (review_id TEXT PRIMARY KEY, ran_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS digest_items (item_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, kind TEXT NOT NULL, knowledge_id TEXT NOT NULL, submission_id TEXT, snapshot TEXT NOT NULL, reason TEXT NOT NULL, answer INTEGER, free_text TEXT, answered_at TEXT, applied INTEGER NOT NULL DEFAULT 0, stale INTEGER NOT NULL DEFAULT 0, notified_at TEXT);
`;
