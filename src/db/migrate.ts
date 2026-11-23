// 表の作成と変更（マイグレーション）。どこまで適用したかは SQLite の PRAGMA user_version に持つ。
// 表を変えるときは、下の列の末尾に次の番号を足す。適用済みの番号の SQL は書き換えない
import type Database from "better-sqlite3";
import { applyKind, becomeDemo } from "../facility/seed";
import { CREATE_SQL } from "./schema";

/** マイグレーションに渡す、開くクリニックのこと（run が種類で分かれるときに使う）。渡さなければ未定（何も入れない側） */
export type MigrationEnv = { kind: "demo" | "real" | "undecided"; at: string };

/** sql を流したあと、run があれば続けて呼ぶ（同じトランザクションの中。表の形で分かれる直しに使う） */
export type Migration = { version: number; sql: string; run?: (sqlite: Database.Database, env: MigrationEnv) => void };

/** クリニックの種類の書き換えを止めるトリガー（未定 → demo／real の 1 回だけを許す） */
const TENANTS_KIND_TRIGGER = "CREATE TRIGGER tenants_kind_fixed BEFORE UPDATE OF kind ON tenants WHEN NOT (OLD.kind = 'undecided' AND NEW.kind IN ('demo', 'real')) BEGIN SELECT RAISE(ABORT, 'tenant kind is fixed'); END;";

/** tenant の app.db（data/resemen.db も同じ） */
export const APP_MIGRATIONS: Migration[] = [
  {
    // ベースライン：この仕組みを入れる前から起動時に作っていた表。すでに表がある DB（user_version = 0）も通す
    version: 1,
    sql: `${CREATE_SQL}
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clerks (id TEXT PRIMARY KEY, name TEXT NOT NULL, call_name TEXT NOT NULL, character_id TEXT NOT NULL, role TEXT NOT NULL, session_id TEXT);
CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, clerk_id TEXT NOT NULL, claim_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chart_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL, facts TEXT, clerk_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS patient_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_key TEXT NOT NULL, fact_key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, valid_until TEXT, checked_at TEXT NOT NULL, checked_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS peer_questions (id TEXT PRIMARY KEY, from_clerk TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, answered_by TEXT, knowledge_id TEXT, created_at TEXT NOT NULL, answered_at TEXT);
`,
  },
  {
    // 監査ログ（FR-140。本文・氏名は入れない）と、LLM・音声の 1 日の回数（FR-139。再起動で消えないよう DB に持つ）
    version: 2,
    sql: `
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, demo_now TEXT, user_id TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, target TEXT, result TEXT NOT NULL, status INTEGER NOT NULL);
CREATE TABLE rate_daily (day TEXT NOT NULL, bucket TEXT NOT NULL, user_id TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, bucket, user_id));
`,
  },
  {
    // 会議の整理で対象から外した、版のない提出の id の一覧（JSON 配列の文字列。design.md §4-4）
    version: 3,
    sql: `
ALTER TABLE reviews ADD COLUMN skipped TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    // 患者マスタ（FR-121）：患者と、その保険・公費の加入情報（追記型。coverage_id ごとに最新の 1 行を使う）。
    // 確かめた患者情報（patient_facts）の鍵を「保険者番号-被保険者番号」から患者 id に寄せる。
    // それまでの鍵ごとに患者を 1 人作り（氏名・生年月日は空。次に UKE を読んだときに埋まる）、番号は医保の加入情報として残す
    version: 4,
    sql: `
CREATE TABLE patients (id TEXT PRIMARY KEY, name TEXT, sex INTEGER, birth TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE patient_coverages (id INTEGER PRIMARY KEY AUTOINCREMENT, coverage_id TEXT NOT NULL, patient_id TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL, payer_number TEXT NOT NULL, symbol TEXT NOT NULL DEFAULT '', member_no TEXT NOT NULL, burden_ratio REAL, valid_from TEXT, valid_until TEXT, source TEXT NOT NULL, checked_by TEXT, checked_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX patient_coverages_patient ON patient_coverages (patient_id);
CREATE INDEX patient_coverages_number ON patient_coverages (payer_number, member_no);
CREATE TABLE patient_key_map (old_key TEXT PRIMARY KEY, patient_id TEXT NOT NULL, at TEXT NOT NULL);
INSERT INTO patient_key_map (old_key, patient_id, at)
  SELECT patient_key, 'P' || printf('%04d', ROW_NUMBER() OVER (ORDER BY MIN(id))), MIN(checked_at) FROM patient_facts GROUP BY patient_key;
INSERT INTO patients (id, source, updated_at) SELECT patient_id, '移行', at FROM patient_key_map;
INSERT INTO patient_coverages (coverage_id, patient_id, kind, position, payer_number, member_no, source, created_at)
  SELECT '', patient_id, '医保', 0, substr(old_key, 1, instr(old_key, '-') - 1), substr(old_key, instr(old_key, '-') + 1), '移行', at
  FROM patient_key_map WHERE instr(old_key, '-') > 1 ORDER BY patient_id;
UPDATE patient_coverages SET coverage_id = 'C' || id;
UPDATE patient_facts SET patient_key = (SELECT m.patient_id FROM patient_key_map m WHERE m.old_key = patient_facts.patient_key);
ALTER TABLE patient_facts RENAME COLUMN patient_key TO patient_id;
DROP TABLE patient_key_map;
`,
  },
  {
    // ベテランへの問いが、どの請求の相談から出たか（design.md §11-11「消す」：取り込んだファイルを消すとき、その請求の問いも消す）。それまでの問いは空
    version: 5,
    sql: `
ALTER TABLE peer_questions ADD COLUMN claim_id TEXT;
`,
  },
  {
    // 請求ごとに確かめた事実（その月・その日の出来事についての事実。患者ごとの patient_facts とは別。追記型で、項目と日付ごとに最新の 1 行を使う）。
    // date は日付ごとの事実だけが持ち、ほかは空文字
    version: 6,
    sql: `
CREATE TABLE claim_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL, key TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', value TEXT NOT NULL, source TEXT NOT NULL, checked_by TEXT NOT NULL, checked_at TEXT NOT NULL);
CREATE INDEX claim_facts_claim ON claim_facts (claim_id);
`,
  },
  {
    // その人がこれまでに使った、メンターのセッション id の全部（design.md §11-11「消す」：過去のセッションの記録も消すため）。
    // clerks.session_id は「いま続けるセッション」1 つだけで、世代が変わる・作り直すと前の id を失う。いま入っている id は写す
    version: 7,
    sql: `
CREATE TABLE clerk_sessions (clerk_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (clerk_id, session_id));
INSERT INTO clerk_sessions (clerk_id, session_id) SELECT id, session_id FROM clerks WHERE session_id IS NOT NULL AND session_id != '';
`,
  },
  {
    // 医師に確かめてほしい項目に、医師が「その他」「判定不能」と答えた記録（事実は不明のまま。その他の自由記述は free_text）。
    // 追記型で、請求・項目・日付ごとに最新の 1 行を使う。date は日付ごとの事実だけが持ち、ほかは空文字
    version: 8,
    sql: `
CREATE TABLE doctor_fact_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL, key TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', option TEXT NOT NULL, free_text TEXT, answered_by TEXT NOT NULL, answered_at TEXT NOT NULL);
CREATE INDEX doctor_fact_notes_claim ON doctor_fact_notes (claim_id);
`,
  },
  {
    // 算定プレビューで医療事務が入れた摘要欄の記載（design.md §11-13。導出が needsInput とした記載）。確定したカルテ（請求とその日）ごと。
    // slot は導出の記載の場所（記載の表の行・導出が決めたコード・同じ行とコードの何件目）で、同じ slot は入れ直すと置き換える。
    // text は自由記載で氏名が入り得るので、ログ・監査ログ・AI に送る文脈には出さない
    version: 9,
    sql: `
CREATE TABLE chart_comments (note_id INTEGER NOT NULL, claim_id TEXT NOT NULL, date TEXT NOT NULL, slot TEXT NOT NULL, code TEXT NOT NULL, text TEXT NOT NULL, clerk_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (note_id, slot));
CREATE INDEX chart_comments_claim ON chart_comments (claim_id);
`,
  },
  {
    // 背反の組の院内の知識に USED を出した記録（design.md §14-3。C-172・X-121）：同じ請求・同じ知識は 1 日（日本時間）1 回まで。行があれば、その日はもう出さない
    version: 10,
    sql: `
CREATE TABLE local_used (claim_id TEXT NOT NULL, knowledge_id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (claim_id, knowledge_id, day));
`,
  },
  {
    // 会議の回答で直す背反の組の知識（design.md §14-1。X-118）の、修正版が持つ向きと条件の文（回答 2 のときだけ。ほかの知識・回答は空）
    version: 11,
    sql: `
ALTER TABLE digest_items ADD COLUMN polarity TEXT;
ALTER TABLE digest_items ADD COLUMN condition_note TEXT;
`,
  },
  {
    // 施設の申告（design.md §15-2。FR-188）：追記だけの表。項目ごとに、算定開始年月日つきの履歴から効く行を選ぶ（C-215）。前の行が変更の記録になる。
    // run はクリニックの種類で分ける（C-214）：real は v28 の施設の設定を申告に移し、demo は種を入れる（C-222）、未定は何もしない（選んだときに開き直して入れる）
    version: 12,
    sql: `
CREATE TABLE facility_declarations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_key TEXT NOT NULL, notified TEXT NOT NULL, notified_on TEXT, start_on TEXT, requirement TEXT NOT NULL, choice TEXT, checked_by TEXT NOT NULL, checked_role TEXT NOT NULL, checked_on TEXT, recheck_on TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX facility_declarations_item ON facility_declarations (item_key, id);
`,
    // 種と移し替えは、行に from_month が要るので 13 の run で行う（12 の SQL は書き換えない。12 と 13 は同じ migrate の中で続けて当たる）
  },
  {
    // 施設の申告に「いつの診療月から」（from_month）を足す（design.md §15-2。P-2・docs H-1）。効く行は、その診療年月以前で from_month が最大の組の最新の行。
    // run：種（source: seed）の行は、種の from_month と算定開始年月日で新しい行を追記して直す（becomeDemo）。input・migrated の行は空のまま残す（推し量って埋めない。
    // 空の行は効く行に選ばれず「分からない」）。続けて、クリニックの種類が決まっていれば申告をその種類に合わせる（12 の run だったもの）
    version: 13,
    sql: `
ALTER TABLE facility_declarations ADD COLUMN from_month TEXT;
`,
    run: (sqlite, env) => {
      if (sqlite.prepare("SELECT 1 FROM facility_declarations WHERE source = 'seed' LIMIT 1").get()) becomeDemo(sqlite, env.at);
      applyKind(sqlite, env.kind, env.at);
    },
  },
  {
    // 取り込んだレセプトの点検で、本人が「この請求の点検を確かめた」を押した記録（design.md §14-3・段 17g。L-123）。実在用のクリニックで F10 の処理件数に数える。
    // 同じ請求・同じ本人は 1 件だけ（主キー）。押した日（reviewed_at）を残す。指摘の数や結果は持たない
    version: 14,
    sql: `
CREATE TABLE claim_reviews (claim_id TEXT NOT NULL, clerk_id TEXT NOT NULL, reviewed_at TEXT NOT NULL, PRIMARY KEY (claim_id, clerk_id));
`,
  },
  {
    // カルテの「行ったこと」（design.md §15-6・15-7。段 18a。設計の「マイグレーション 14」を、段 17g が 14 を使ったので 15 にした）。
    // acts：本人が確かめた行為と処方の記載の JSON（当てた結果・その日の院内・院外を含む）。NULL＝行ったことを確かめていない。本文と同じく、ログ・監査ログ・AI に送る文脈には出さない。
    // chart_act_aliases：本人が選んだ「書かれた名前 → コード」（クリニックごと。前に選んだ対応。L-95）。区分誤りの出た対応は点検を呼んだ側が行を消す（C-250）
    version: 15,
    sql: `
ALTER TABLE chart_notes ADD COLUMN acts TEXT;
CREATE TABLE chart_act_aliases (written_norm TEXT NOT NULL, tbl TEXT NOT NULL, code TEXT NOT NULL, chosen_by TEXT NOT NULL, chosen_at TEXT NOT NULL, PRIMARY KEY (written_norm, tbl));
`,
  },
  {
    // 注14 の計算の道具の結果（design.md §15-13。段 17i）。追記だけ。使った期間（3 か月と 1 年の初めと終わりの月。C-325）を列に持つ。
    // inputs は入力の数と出どころ（自動・手入力）の JSON、outcomes は読みの組み合わせごとの結果、splits は割れた軸の一覧。集計の数だけで、患者の氏名・生年月日・番号・鍵は持たない。
    // result は meets・not_meets・undecided。判定（R01〜R19・G01〜G11）はこの表を読まない
    version: 16,
    sql: `
CREATE TABLE note14_worksheets (id INTEGER PRIMARY KEY AUTOINCREMENT, check_month TEXT NOT NULL, period_3m_from TEXT NOT NULL, period_3m_to TEXT NOT NULL, period_12m_from TEXT NOT NULL, period_12m_to TEXT NOT NULL, inputs TEXT NOT NULL, outcomes TEXT NOT NULL, result TEXT NOT NULL, splits TEXT NOT NULL, checked_by TEXT NOT NULL, checked_on TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX note14_worksheets_month ON note14_worksheets (check_month, id);
`,
  },
  {
    // カルテの構造化データ（design.md §16-1・16-8。段 19a。L-165）。追記だけ。
    // chart_structured：接続先から読んだ 4 種類を、その月の点検に使った形のまま残す（同じ患者・月・種類は最新の行を使う）。part は visits・orders・procedures・homeCare、
    // status は supported・unsupported、items は行の JSON、gaps は欄ごとの欠けの数の JSON（手元で数えたもの）。
    // structured_inputs：医療事務が入れた訪問の時刻（16-6）。どちらも患者 id を持つので、患者マスタを消すときに一緒に消す。ログ・監査ログ・AI に送る文脈に値を出さない
    version: 17,
    sql: `
CREATE TABLE chart_structured (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, year_month TEXT NOT NULL, part TEXT NOT NULL, status TEXT NOT NULL, items TEXT NOT NULL, gaps TEXT NOT NULL, connector_id TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE INDEX chart_structured_month ON chart_structured (patient_id, year_month, part, id);
CREATE TABLE structured_inputs (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, date TEXT NOT NULL, visit_ref TEXT, start TEXT NOT NULL, end TEXT NOT NULL, entered_by TEXT NOT NULL, entered_at TEXT NOT NULL);
CREATE INDEX structured_inputs_patient ON structured_inputs (patient_id, date, id);
`,
  },
  {
    // 電子カルテの独自コードの対応表（design.md §16-2・16-8。段 19b。L-167・L-213）。クリニックごとに、接続先・入力欄の種類（薬・材料・行為・指導管理・機器）・コードの体系・独自コードの組で 1 行。
    // tbl はその欄の当ててよい表（機器は device）、code は当てたコード（機器は区分キー）。患者・請求の id を持たない（消す操作で残るもの。chart_act_aliases と同じ）。AI には送らない
    version: 18,
    sql: `
CREATE TABLE ext_code_maps (connector_id TEXT NOT NULL, field TEXT NOT NULL, system TEXT NOT NULL, ext_code TEXT NOT NULL, tbl TEXT NOT NULL, code TEXT NOT NULL, chosen_by TEXT NOT NULL, chosen_at TEXT NOT NULL, PRIMARY KEY (connector_id, field, system, ext_code));
`,
  },
  {
    // 患者の在宅療養の機器と、電子カルテからの変える案（design.md §16-5・16-8。段 19e。FR-208）。どちらも追記だけ。
    // patient_devices：kind は機器の種類（DEVICE_KINDS のキー）か none（機器なし）。detail は C150 の段と患者の区分の JSON。source は「電子カルテ（確かめた）」か「医療事務が入れた」。
    // device_proposals：電子カルテの指示と効く行の違い。kind は当てた種類（当てられなければ NULL）。decision は accept・reject（決めるまで NULL）。
    // どちらも患者 id を持つので、患者マスタを消すときに一緒に消す。ログ・監査ログ・AI に送る文脈に機器の値を出さない（監査ログは種類の鍵だけ）
    version: 19,
    sql: `
CREATE TABLE patient_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, kind TEXT NOT NULL, from_month TEXT NOT NULL, end_month TEXT, detail TEXT, source TEXT NOT NULL, checked_by TEXT NOT NULL, checked_at TEXT NOT NULL);
CREATE INDEX patient_devices_patient ON patient_devices (patient_id, id);
CREATE TABLE device_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, kind TEXT, started_on TEXT, ended_on TEXT, ref TEXT NOT NULL, connector_id TEXT NOT NULL, received_at TEXT NOT NULL, decision TEXT, decided_by TEXT, decided_at TEXT);
CREATE INDEX device_proposals_patient ON device_proposals (patient_id, id);
`,
  },
];

/** ログインの auth.db */
export const AUTH_MIGRATIONS: Migration[] = [
  {
    // ベースライン（上と同じ扱い）
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
`,
  },
  {
    // 利用者はクリニック（tenant）に属し、ロールを 1 つ持つ（FR-132）。それまでの利用者は 1 人 1 クリニックなので、
    // tenant_id は自分の id、ロールは今までの操作（算定）を続けられる事務にする。
    // 招待（FR-137。コードはハッシュだけ）と、ログインまわりの監査（FR-140）の表も足す
    version: 2,
    sql: `
ALTER TABLE users ADD COLUMN tenant_id TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'clerk';
UPDATE users SET tenant_id = id WHERE tenant_id IS NULL;
CREATE INDEX users_tenant ON users (tenant_id);
CREATE TABLE invites (code_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT);
CREATE TABLE auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL, result TEXT NOT NULL, user_id TEXT, tenant_id TEXT, ip TEXT);
`,
  },
  {
    // 注意書きへの同意（design.md §11-11）：利用者ごとに、同意した注意書きの版と時刻。それまでの利用者は空（次の操作で聞かれる）
    version: 3,
    sql: `
ALTER TABLE users ADD COLUMN accepted_notice_version TEXT;
ALTER TABLE users ADD COLUMN accepted_notice_at TEXT;
`,
  },
  {
    // サーバー全体の 1 日の回数（spec U-W。2026-11-21 利用者の判断）：LLM・音声の呼び出しを、全部のクリニック・全部の利用者で数える。
    // 利用者ごとの数は tenant の app.db の rate_daily にあり、ここには全体の数だけを置く（user_id は '*'）
    version: 4,
    sql: `
CREATE TABLE rate_daily (day TEXT NOT NULL, bucket TEXT NOT NULL, user_id TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, bucket, user_id));
`,
  },
  {
    // クリニックの種類（2026-11-22 利用者の判断）：demo＝作り物のデータ入り・デモの時計／real＝実在のデータ・実際の日付／undecided＝未定。
    // 新しいクリニックは作るときに決める。それまでのクリニック（利用者の tenant_id）は未定にし、事務長が次に入ったときに一度だけ選ぶ（decided_at）。
    // 書き換えは「未定 → demo／real」の 1 回だけを許し、ほかはトリガーで止める
    version: 5,
    sql: `
CREATE TABLE tenants (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('demo', 'real', 'undecided')), created_at TEXT NOT NULL, decided_at TEXT);
INSERT INTO tenants (id, kind, created_at) SELECT tenant_id, 'undecided', MIN(created_at) FROM users WHERE tenant_id IS NOT NULL GROUP BY tenant_id;
CREATE TRIGGER tenants_kind_fixed BEFORE UPDATE OF kind ON tenants WHEN NOT (OLD.kind = 'undecided' AND NEW.kind IN ('demo', 'real')) BEGIN SELECT RAISE(ABORT, 'tenant kind is fixed'); END;
`,
  },
  {
    // 前の版の 5（fix/demo-real の 2e03207 まで）を当てた auth.db を、今の形にそろえる（反証 round-44 #1）。
    // 前の版の 5 は、表に decided_at と未定がなく、それまでのクリニックを demo にし、書き換えを全部止めていた。
    // その DB では表を作り直し、demo の行を未定にする（前の版で登録のときに demo を選んだクリニックも、区別できないので未定にする。安全側）。
    // real の行は、登録のときに選んだもの（decided_at は作った日時）。トリガーは今の形に入れ替える。
    // 今の 5 を当てた DB では、選んだ日時のない demo・real の行（登録のときに選んだもの）に、作った日時を選んだ日時として入れるだけ
    version: 6,
    sql: "",
    run: (db) => {
      const columns = (db.prepare("PRAGMA table_info(tenants)").all() as { name: string }[]).map((c) => c.name);
      db.exec("DROP TRIGGER IF EXISTS tenants_kind_fixed;");
      if (!columns.includes("decided_at")) {
        db.exec(`
CREATE TABLE tenants_v6 (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('demo', 'real', 'undecided')), created_at TEXT NOT NULL, decided_at TEXT);
INSERT INTO tenants_v6 (id, kind, created_at, decided_at)
  SELECT id, CASE kind WHEN 'real' THEN 'real' ELSE 'undecided' END, created_at, CASE kind WHEN 'real' THEN created_at ELSE NULL END FROM tenants;
DROP TABLE tenants;
ALTER TABLE tenants_v6 RENAME TO tenants;
`);
      } else {
        db.exec("UPDATE tenants SET decided_at = created_at WHERE decided_at IS NULL AND kind IN ('demo', 'real');");
      }
      db.exec(TENANTS_KIND_TRIGGER);
    },
  },
];

const versionOf = (sqlite: Database.Database) => sqlite.pragma("user_version", { simple: true }) as number;

/**
 * まだ適用していない番号を、1 つのトランザクションの中で順に適用する。適用後のバージョンを返す。
 * 途中で失敗したら全部を巻き戻し、バージョンも進めない。DB のほうが新しいとき（古いコードで開いたとき）は、知らない表を壊さないよう止める
 */
export function migrate(sqlite: Database.Database, migrations: Migration[], env: MigrationEnv = { kind: "undecided", at: new Date().toISOString() }): number {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`マイグレーションの番号が連番でない: ${i + 1} 番目が ${m.version}`);
  });
  const current = versionOf(sqlite);
  if (current > migrations.length) throw new Error(`DB のバージョン ${current} がコードの ${migrations.length} より新しい。新しいコードで起動する`);
  if (current === migrations.length) return current;
  return sqlite
    .transaction(() => {
      // ほかのプロセスが先に適用していることがあるので、書き込みのロックを取ってから読み直す
      for (const m of migrations.slice(versionOf(sqlite))) {
        if (m.sql) sqlite.exec(m.sql);
        m.run?.(sqlite, env);
        sqlite.pragma(`user_version = ${m.version}`);
      }
      return versionOf(sqlite);
    })
    .immediate();
}
