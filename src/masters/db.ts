// masters.db（公開データを取り込んだ SQLite。design.md §12-1）を、アプリから読む。読み取り専用で開き、なければ「ない」を返す（例外にしない）。
// 作るのは scripts/build-masters.ts（src/masters/build.ts）だけ。中身は公開元の値そのままで、患者の情報は入らない
import path from "node:path";
import Database from "better-sqlite3";
import { YEAR_MONTH } from "../demo/period";
import { dataDir } from "../server/auth-db";

/** masters.db のあるフォルダ。既定は <データ置き場>/masters。RESEMEN_MASTER_DIR があればそこ（テストと、別の場所に置くとき） */
export const mastersDir = (): string => path.resolve(process.env.RESEMEN_MASTER_DIR ?? path.join(dataDir(), "masters"));
export const mastersDbPath = (): string => path.join(mastersDir(), "masters.db");

export type MastersDb = Database.Database;

/** masters.db を読み取り専用で開く。ファイルがない・開けないときは null */
export function openMasters(file: string = mastersDbPath()): MastersDb | null {
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/**
 * masters.db を読む処理 1 つ分：開いて、fn に渡して、閉じる。ない（開けない）ときは null を渡す。
 * 別の作り方の masters.db（表がない）は、ないものとして扱う（fn を null でやり直す。fn は読むだけにする）
 */
export function withMasters<T>(fn: (db: MastersDb | null) => T): T {
  const db = openMasters();
  if (!db) return fn(null);
  try {
    return fn(db);
  } catch (e) {
    if (e instanceof Database.SqliteError) return fn(null);
    throw e;
  } finally {
    db.close();
  }
}

/** 取り込んだファイル 1 つ。verified は、読み方を確かめた版の更新日（EM §2-11。確かめた版のないデータは null） */
export type SourceRow = { dataset: string; snapshot: string; generation: string; tbl: string; file: string; sha256: string; rows: number; imported_at: string; verified: string | null };

/** 入っているデータの一覧（データ名・更新日・表の順） */
export const sourcesOf = (db: MastersDb): SourceRow[] => db.prepare("SELECT * FROM sources ORDER BY dataset, snapshot, tbl, file").all() as SourceRow[];

/** 使う 1 枚。later が真＝診療年月より前の 1 枚がなく、後の 1 枚で代えている（その行に依る指摘は条件つきにする。design.md §12-1） */
export type Snapshot = { snapshot: string; later: boolean };

/**
 * 診療年月から、そのデータの使う 1 枚を選ぶ（design.md §12-1）：診療年月の末日以前で、いちばん新しい 1 枚。
 * なければ、後のいちばん古い 1 枚（later が真）。その世代の 1 枚が 1 つもなければ null（近い世代で代用しない）
 */
export function pickSnapshot(db: MastersDb, dataset: string, yearMonth: string, generation: string): Snapshot | null {
  if (!YEAR_MONTH.test(yearMonth)) return null;
  const end = `${yearMonth.replace("-", "")}31`;
  const all = (db.prepare("SELECT DISTINCT snapshot FROM sources WHERE dataset = ? AND generation = ? ORDER BY snapshot").all(dataset, generation) as { snapshot: string }[]).map((r) => r.snapshot);
  if (all.length === 0) return null;
  const before = all.filter((s) => s <= end);
  return before.length > 0 ? { snapshot: before[before.length - 1], later: false } : { snapshot: all[0], later: true };
}

/** 医科診療行為マスターの 1 行（列の意味は src/masters/layout.ts） */
export type ShinryoRow = {
  code: string; name: string; change: string; point_kind: string; points: number; nyugai: string; kouki: string; shukei_gai: number; houkatsu_kensa: string;
  hospital_clinic: string; shobyo_kanren: string; jitsunissu: string; nissu_kaisu: string;
  kizami_kind: string; kizami_lower: number; kizami_upper: number; kizami_step: number; kizami_points: number; kizami_error: string;
  limit_count: number; limit_error: string; chu_code: number; chu_seq: string; tsusoku_age: string; age_lower: string; age_upper: string; time_kasan: string;
  kensa_kind: string; kensa_group: number; kokuji1: string; kokuji2: string; shisetsu: string; alpha: string; changed_on: string; abolished_on: string;
  sho: number; bu: number; kubun_no: number; eda: number; kou: number;
};
export type IyakuhinRow = { code: string; name: string; change: string; unit_code: number; price_kind: string; price: number; zaikei: string; changed_on: string; abolished_on: string; keika_until: number };
export type TokuteiRow = { code: string; name: string; change: string; unit_code: number; price_kind: string; price: number; sanso: string; changed_on: string; keika_until: string; abolished_on: string };

/** コードごとに引く文は、接続ごとに 1 回だけ用意する（コードの数だけ prepare すると、5,000 行のレセプトでは引く時間の多くが prepare になる。round-32 S-9） */
const statements = new WeakMap<MastersDb, Map<string, Database.Statement>>();
const prepared = (db: MastersDb, sql: string): Database.Statement => {
  const m = statements.get(db) ?? new Map<string, Database.Statement>();
  statements.set(db, m);
  const s = m.get(sql) ?? db.prepare(sql);
  m.set(sql, s);
  return s;
};

const one = <T>(db: MastersDb, table: "shinryo" | "iyakuhin" | "tokutei", snapshot: string, code: string): T | null =>
  (prepared(db, `SELECT * FROM ${table} WHERE snapshot = ? AND code = ?`).get(snapshot, code) as T | undefined) ?? null;

/** コードから行を引く（その 1 枚にないコードは null） */
export const shinryoOf = (db: MastersDb, snapshot: string, code: string): ShinryoRow | null => one<ShinryoRow>(db, "shinryo", snapshot, code);
export const iyakuhinOf = (db: MastersDb, snapshot: string, code: string): IyakuhinRow | null => one<IyakuhinRow>(db, "iyakuhin", snapshot, code);
export const tokuteiOf = (db: MastersDb, snapshot: string, code: string): TokuteiRow | null => one<TokuteiRow>(db, "tokutei", snapshot, code);

/** 名称を引ける基本マスター（データの名前と表の名前が同じもの） */
export type NamedMaster = "shinryo" | "iyakuhin" | "tokutei" | "comment" | "shobyo";

/** その 1 枚の、そのコードの名称（その 1 枚にないコードは null）。コメントマスターは定型文、傷病名マスターは傷病名 */
export const nameOf = (db: MastersDb, table: NamedMaster, snapshot: string, code: string): string | null =>
  (prepared(db, `SELECT name FROM ${table} WHERE snapshot = ? AND code = ?`).get(snapshot, code) as { name: string } | undefined)?.name ?? null;

/** そのデータの、持っている 1 枚を全部（更新日の古い順）。generation を渡せば、その世代のものだけ */
export const snapshotsOf = (db: MastersDb, dataset: string, generation?: string): string[] =>
  (prepared(db, "SELECT DISTINCT snapshot FROM sources WHERE dataset = ? AND (? IS NULL OR generation = ?) ORDER BY snapshot").all(dataset, generation ?? null, generation ?? null) as { snapshot: string }[]).map((r) => r.snapshot);

/** 点検（G01〜G09）の準備ができているか（要る表がそろい、錨が通ったか。作るのは src/masters/verify.ts）。行がなければ null */
export function checkReady(db: MastersDb, check: string): { ready: boolean; reason: string } | null {
  const r = db.prepare("SELECT ready, reason FROM checks_ready WHERE check_id = ?").get(check) as { ready: number; reason: string } | undefined;
  return r ? { ready: r.ready === 1, reason: r.reason } : null;
}

/** 設定の画面「マスターの状態」に出すもの（design.md §12-5）。present が偽＝masters.db がない */
export type MastersStatus = {
  present: boolean;
  /** 取り込んだファイル。newer＝読み方を確かめた版（verified）より新しいデータ */
  sources: { dataset: string; snapshot: string; table: string; file: string; rows: number; importedAt: string; verified: string | null; newer: boolean }[];
  /** 点検 G01〜G09 の準備（要る表がそろい、錨が通ったか） */
  checks: { check: string; ready: boolean; reason: string }[];
  /** 形式が合わず、取り込まなかったファイル */
  rejected: { dataset: string; snapshot: string; file: string; reason: string }[];
};

export function mastersStatus(): MastersStatus {
  const db = openMasters();
  if (!db) return { present: false, sources: [], checks: [], rejected: [] };
  try {
    return {
      present: true,
      sources: sourcesOf(db).map((s) => ({ dataset: s.dataset, snapshot: s.snapshot, table: s.tbl, file: s.file, rows: s.rows, importedAt: s.imported_at, verified: s.verified, newer: s.verified !== null && s.snapshot > s.verified })),
      checks: (db.prepare("SELECT check_id, ready, reason FROM checks_ready ORDER BY check_id").all() as { check_id: string; ready: number; reason: string }[]).map((c) => ({ check: c.check_id, ready: c.ready === 1, reason: c.reason })),
      rejected: db.prepare("SELECT dataset, snapshot, file, reason FROM rejected ORDER BY dataset, snapshot, file").all() as MastersStatus["rejected"],
    };
  } catch {
    // 別の作り方の masters.db（表がない）は、ないものとして扱う
    return { present: false, sources: [], checks: [], rejected: [] };
  } finally {
    db.close();
  }
}
