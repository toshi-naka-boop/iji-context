// ログイン（spec FR-72）：ログイン ID とパスワード。パスワードは Node 標準の scrypt でハッシュにして保存し、平文は残さない。
// セッションはランダムなトークンを httpOnly の cookie で渡し、DB にはトークンのハッシュだけを置く。
// 利用者のデータはクリニック（tenant）ごとに分ける。招待で入った利用者は、招待した側のクリニックに属する（src/server/instance.ts）
import Database from "better-sqlite3";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import NOTICE from "../../config/notice.json";
import { AUTH_MIGRATIONS, migrate } from "../db/migrate";
import { badRequest, conflict, forbidden, notFound } from "./errors";
import { isRole, type Role } from "./roles";
import { isTenantKind, type TenantKind, type TenantStatus } from "./tenant-kind";

export { SESSION_COOKIE } from "./auth-cookie";
const SESSION_DAYS = 30;
/** 使い方が未定のクリニックで、選ぶまで待ってもらうときの文言（src/server/errors.ts の TenantUndecided と同じ） */
const UNDECIDED_WAIT = "事務長がこのクリニックの使い方を選ぶまでお待ちください";
/** 実在のデータで使うクリニックで、医師の役割に変えようとしたときの文言 */
const DOCTOR_BY_INVITE = "実在のデータで使うクリニックでは、医師の役割に切り替えられません。医師には、医師の役割の招待コードで登録してもらってください";
/** 招待コードの期限（日） */
const INVITE_DAYS = 7;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** 利用者。クリニック（tenant）に属し、ロールを 1 つ持つ（FR-132）。1 人で始めたクリニックの持ち主は tenantId が自分の id */
export type User = { id: string; login: string; name: string; tenantId: string; role: Role };

/** 招待なしの登録（新しい 1 人クリニックを作る）を許すか。環境変数で明示したときだけ（FR-137。既定は閉じる） */
export const openSignup = () => process.env.RESEMEN_OPEN_SIGNUP === "1";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, n, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** ログイン ID：英数字と _ . -（3〜32 文字）。名前（呼ばれたい名前）は 1〜20 文字。パスワードは 8〜128 文字 */
export function validateRegistration(login: string, name: string, password: string): void {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(login)) throw badRequest("ログイン ID は英数字と _ . - の 3〜32 文字にしてください", ["login"]);
  if (name.trim().length < 1 || name.trim().length > 20) throw badRequest("名前は 1〜20 文字にしてください", ["name"]);
  if (password.length < 8 || password.length > 128) throw badRequest("パスワードは 8 文字以上にしてください", ["password"]);
}

/** ログインの失敗が続いたら、しばらく受け付けない（総当たりを遅らせる。プロセスの中だけで数える） */
export class Throttle {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  blocked(key: string, now = Date.now()): boolean {
    const xs = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    // 残っていないキーは持たない（毎回違うキーで叩かれても増え続けないように）
    if (xs.length === 0) this.hits.delete(key);
    else this.hits.set(key, xs);
    return xs.length >= this.max;
  }
  hit(key: string, now = Date.now()) {
    this.hits.set(key, [...(this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs), now]);
  }
  clear(key: string) {
    this.hits.delete(key);
  }
}

/** ない ID のときに照合する相手（起動時に 1 回だけ作る） */
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

/** 日本時間の日付（src/server/rate-limit.ts の jstDay と同じ式。rate-limit.ts が auth.ts を import するので、循環を避けてここにも置く） */
const jstDayOf = (now: Date) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

export function openAuth(dbFile: string) {
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  migrate(db, AUTH_MIGRATIONS);
  type Row = { id: string; login: string; name: string; tenant_id: string | null; role: string };
  const toUser = (r: Row): User => ({ id: r.id, login: r.login, name: r.name, tenantId: r.tenant_id ?? r.id, role: isRole(r.role) ? r.role : "clerk" });

  /** into が null なら新しいクリニックを作る（種類は kind）。クリニックの行と利用者の行は同じトランザクションで入れる */
  function insertUser(login: string, name: string, password: string, into: { tenantId: string; role: Role } | null, kind: TenantKind = "demo"): User {
    validateRegistration(login, name, password);
    if (into === null && !isTenantKind(kind)) throw badRequest("クリニックの種類を選んでください", ["kind"]);
    if (db.prepare("SELECT 1 FROM users WHERE login = ?").get(login)) throw conflict("そのログイン ID は使われています");
    const id = `t${randomBytes(6).toString("hex")}`;
    const user: User = { id, login, name: name.trim(), tenantId: into?.tenantId ?? id, role: into?.role ?? "clerk" };
    const at = new Date().toISOString();
    db.transaction(() => {
      // 登録のときに選んだので、選んだ日時は作った日時
      if (into === null) db.prepare("INSERT INTO tenants (id, kind, created_at, decided_at) VALUES (?, ?, ?, ?)").run(id, kind, at, at);
      db.prepare("INSERT INTO users (id, login, name, password_hash, created_at, tenant_id, role) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, login, user.name, hashPassword(password), at, user.tenantId, user.role);
    })();
    return user;
  }
  /**
   * 新しい 1 人クリニックを作って登録する（招待なし）。API からは、開放登録を明示したときだけ呼ぶ（openSignup）。
   * kind はクリニックの種類（作るときに決め、変えない）。API は利用者が選んだ値を必ず渡す。省くのはテスト・スクリプトだけ（demo）
   */
  const register = (login: string, name: string, password: string, kind: TenantKind = "demo"): User => insertUser(login, name, password, null, kind);
  /** クリニックの種類。行のないクリニック・読めない値は未定（安全側。demo とはみなさない） */
  const tenantKind = (tenantId: string): TenantStatus => {
    const k = (db.prepare("SELECT kind FROM tenants WHERE id = ?").get(tenantId) as { kind: string } | undefined)?.kind;
    return isTenantKind(k) ? k : "undecided";
  };
  /** クリニックの使い方を選んだ日時（未定・行のないものは null）。登録のときに選んだクリニックは、作った日時 */
  const tenantDecidedAt = (tenantId: string): string | null => (db.prepare("SELECT decided_at FROM tenants WHERE id = ?").get(tenantId) as { decided_at: string | null } | undefined)?.decided_at ?? null;
  /** 未定のクリニックの種類を選べるか：事務長と、1 人で使っているクリニックの持ち主 */
  const canChooseKind = (user: User): boolean => tenantKind(user.tenantId) === "undecided" && (user.role === "manager" || isSolo(user));
  /**
   * 未定のクリニックの種類を、一度だけ選ぶ（2026-11-22 利用者の判断）。選んだあとは変えられない（DB のトリガーでも止める）。
   * 行がない未定のクリニックには、行を作る
   */
  function chooseKind(user: User, kind: TenantKind, now = new Date()): TenantKind {
    if (!isTenantKind(kind)) throw badRequest("「デモで試す」か「実在のデータで使う」かを選んでください", ["kind"]);
    return db
      .transaction(() => {
        if (tenantKind(user.tenantId) !== "undecided") throw conflict("このクリニックの使い方は、すでに決まっています（変えられません）");
        if (!(user.role === "manager" || isSolo(user))) throw forbidden("クリニックの使い方を選べるのは事務長だけです");
        const at = now.toISOString();
        const r = db.prepare("UPDATE tenants SET kind = ?, decided_at = ? WHERE id = ? AND kind = 'undecided'").run(kind, at, user.tenantId);
        if (r.changes === 0) db.prepare("INSERT INTO tenants (id, kind, created_at, decided_at) VALUES (?, ?, ?, ?)").run(user.tenantId, kind, at, at);
        return kind;
      })
      .immediate();
  }

  /** クリニックの利用者の人数 */
  const tenantSize = (tenantId: string) => (db.prepare("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?").get(tenantId) as { n: number }).n;
  /** 1 人で始めたクリニックの持ち主で、まだほかの利用者がいない */
  const isSolo = (user: User) => user.tenantId === user.id && tenantSize(user.tenantId) === 1;
  /** 招待を作れるのは事務長と、1 人クリニックの持ち主 */
  const canInvite = (user: User) => user.role === "manager" || isSolo(user);

  /**
   * 招待コードを作る（FR-137）：1 回だけ使え、期限があり、クリニックとロールが決まっている。
   * コードそのものは返すだけで、DB にはハッシュだけを置く
   */
  function createInvite(by: User, role: Role, now = new Date()): { code: string; role: Role; expiresAt: string } {
    if (!canInvite(by)) throw forbidden("招待を作れるのは事務長だけです");
    // 使い方が未定のあいだは招待を作らない（人が増えると、1 人のクリニックの持ち主が使い方を選べなくなる。反証 round-44 #4）
    if (tenantKind(by.tenantId) === "undecided") throw conflict(UNDECIDED_WAIT);
    const code = randomBytes(16).toString("base64url");
    const expiresAt = new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString();
    db.prepare("INSERT INTO invites (code_hash, tenant_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(sha256(code), by.tenantId, role, by.id, now.toISOString(), expiresAt);
    return { code, role, expiresAt };
  }
  /** 画面に出す招待の id。コードのハッシュそのものは外に出さない（もう一度ハッシュにして、先頭だけを使う） */
  const inviteId = (codeHash: string) => sha256(`invite-id:${codeHash}`).slice(0, 16);
  type InviteRow = { code_hash: string; role: string; created_at: string; expires_at: string; used_at: string | null };
  const invitesOf = (tenantId: string) => db.prepare("SELECT code_hash, role, created_at, expires_at, used_at FROM invites WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC").all(tenantId) as InviteRow[];
  /** 自分のクリニックで発行した招待の一覧（新しい順）。コードもハッシュも返さない */
  function listInvites(by: User, now = new Date()): { id: string; role: Role; createdAt: string; expiresAt: string; used: boolean; expired: boolean }[] {
    if (!canInvite(by)) throw forbidden("招待を見られるのは事務長だけです");
    return invitesOf(by.tenantId).map((r) => ({ id: inviteId(r.code_hash), role: isRole(r.role) ? r.role : "clerk", createdAt: r.created_at, expiresAt: r.expires_at, used: r.used_at !== null, expired: r.used_at === null && r.expires_at <= now.toISOString() }));
  }
  /**
   * 未使用の招待を取り消す（行を消す。そのコードでは登録できなくなる）。使用済みは取り消せない。
   * ほかのクリニックの招待は「ない」として扱う
   */
  function revokeInvite(by: User, id: string): { id: string; role: string } {
    if (!canInvite(by)) throw forbidden("招待を取り消せるのは事務長だけです");
    return db
      .transaction(() => {
        const inv = invitesOf(by.tenantId).find((r) => inviteId(r.code_hash) === id);
        if (!inv) throw notFound("その招待はありません（取り消し済みかもしれません）");
        if (inv.used_at !== null) throw conflict("使用済みの招待は取り消せません");
        db.prepare("DELETE FROM invites WHERE code_hash = ? AND used_at IS NULL").run(inv.code_hash);
        return { id, role: inv.role };
      })
      .immediate();
  }
  /**
   * 招待コードで登録する。招待のクリニックとロールで利用者を作り、招待を使用済みにする（同じトランザクション）。
   * まちがい・使用済み・期限切れは同じ文言で断る（どれなのかを外に教えない）
   */
  function registerWithInvite(login: string, name: string, password: string, code: string, now = new Date()): User {
    const refuse = () => forbidden("招待コードが使えません（まちがい・使用済み・期限切れのいずれかです）");
    return db
      .transaction(() => {
        const hash = sha256(code);
        const inv = db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(hash) as { code_hash: string; tenant_id: string; role: string; expires_at: string; used_at: string | null } | undefined;
        // 照合は長さの決まったハッシュどうしを、時間差の出ない比較で行う（見つからないときも同じだけ比べる）
        const same = timingSafeEqual(Buffer.from(inv?.code_hash ?? sha256(""), "hex"), Buffer.from(hash, "hex"));
        if (!inv || !same || inv.used_at !== null || inv.expires_at <= now.toISOString() || !isRole(inv.role)) throw refuse();
        // 招待したクリニックの使い方が未定のあいだは受けない（招待は使わずに残す。選んだあとに使える）
        if (tenantKind(inv.tenant_id) === "undecided") throw conflict(UNDECIDED_WAIT);
        const user = insertUser(login, name, password, { tenantId: inv.tenant_id, role: inv.role });
        db.prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL").run(now.toISOString(), user.id, hash);
        return user;
      })
      .immediate();
  }

  /**
   * 自分の役割を切り替える（FR-144）。1 人で始めたクリニックで、ほかの利用者がいないときだけ（1 人で全部の役を通して使うため）。
   * 利用者が 2 人以上いるクリニックではできない。医師への切り替えは、デモで試すクリニックだけ（実在のデータで使うクリニックでは、
   * 持ち主が医師になって医師確認の回答・承認を自分でできてしまうので、医師は招待で入った医師のアカウントに限る）
   */
  function switchRole(user: User, role: Role): User {
    if (!isSolo(user)) throw forbidden("役割を切り替えられるのは、1 人で使っているクリニックだけです");
    if (role === "doctor" && tenantKind(user.tenantId) !== "demo") throw forbidden(DOCTOR_BY_INVITE);
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, user.id);
    return { ...user, role };
  }

  /**
   * 注意書きへの同意（design.md §11-11）。利用者ごとに、注意書きの版ごとに 1 回。同意できるのは今の版だけ
   * （古い画面が持っている版で同意しても、今の版に同意したことにしない）
   */
  function acceptNotice(userId: string, version: string, now = new Date()): { version: string; at: string } {
    if (version !== NOTICE.version) throw conflict("注意書きが更新されています。画面を読み込み直してから、もう一度確かめてください");
    const at = now.toISOString();
    db.prepare("UPDATE users SET accepted_notice_version = ?, accepted_notice_at = ? WHERE id = ?").run(version, at, userId);
    return { version, at };
  }
  /** その利用者が、今の版の注意書きに同意しているか。呼ぶたびに DB を読む（セッションに覚えさせない） */
  const acceptedNotice = (userId: string): boolean =>
    (db.prepare("SELECT accepted_notice_version AS v FROM users WHERE id = ?").get(userId) as { v: string | null } | undefined)?.v === NOTICE.version;

  /** ログインまわりの監査（FR-140）：ログインの成功・失敗、登録、招待の作成・使用・取り消し、役割の切替。氏名・パスワード・招待コードは入れない */
  function recordEvent(e: { event: string; result: string; userId?: string | null; tenantId?: string | null; ip?: string | null }, now = new Date()) {
    db.prepare("INSERT INTO auth_events (at, event, result, user_id, tenant_id, ip) VALUES (?, ?, ?, ?, ?, ?)").run(now.toISOString(), e.event, e.result, e.userId ?? null, e.tenantId ?? null, e.ip ?? null);
  }
  const eventsOf = (tenantId: string, limit = 100) =>
    db.prepare("SELECT id, at, event, result, user_id AS userId, ip FROM auth_events WHERE tenant_id = ? ORDER BY id DESC LIMIT ?").all(tenantId, limit) as { id: number; at: string; event: string; result: string; userId: string | null; ip: string | null }[];
  /** ログイン ID から利用者の id と tenant（ログイン失敗の記録に使う。ない ID なら null） */
  const idOfLogin = (loginId: string) => (db.prepare("SELECT id, tenant_id AS tenantId FROM users WHERE login = ?").get(loginId) as { id: string; tenantId: string } | undefined) ?? null;

  /** ID かパスワードが違えば null（どちらが違うかは言わない） */
  function login(loginId: string, password: string): User | null {
    const r = db.prepare("SELECT * FROM users WHERE login = ?").get(loginId) as (Row & { password_hash: string }) | undefined;
    if (!r) {
      verifyPassword(password, DUMMY_HASH); // 時間で ID の有無が分からないように（ある ID と同じく照合を 1 回だけ回す）
      return null;
    }
    return verifyPassword(password, r.password_hash) ? toUser(r) : null;
  }
  function createSession(userId: string, now = new Date()): { token: string; expires: Date } {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
    // 期限切れのセッションは、ログイン・登録のたびにまとめて消す（そのトークンで参照されない行が残り続けないように）
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sha256(token), userId, expires.toISOString(), now.toISOString());
    return { token, expires };
  }
  function userOfSession(token: string | undefined, now = new Date()): User | null {
    if (!token) return null;
    const r = db
      .prepare("SELECT u.id, u.login, u.name, u.tenant_id, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
      .get(sha256(token)) as (Row & { expires_at: string }) | undefined;
    if (!r) return null;
    if (r.expires_at <= now.toISOString()) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
      return null;
    }
    return toUser(r);
  }
  function endSession(token: string | undefined) {
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }
  /** サーバー全体の 1 日の回数（auth.db の rate_daily。user_id は '*'）。形は src/server/rate-limit.ts の DailyCounter と同じ */
  const dailyAll = {
    hit: (bucket: string, userId: string, now = new Date()): number =>
      (db.prepare("INSERT INTO rate_daily (day, bucket, user_id, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, bucket, user_id) DO UPDATE SET count = count + 1 RETURNING count").get(jstDayOf(now), bucket, userId) as { count: number }).count,
    count: (bucket: string, userId: string, now = new Date()): number =>
      (db.prepare("SELECT count FROM rate_daily WHERE day = ? AND bucket = ? AND user_id = ?").get(jstDayOf(now), bucket, userId) as { count: number } | undefined)?.count ?? 0,
  };
  return { dailyAll, acceptNotice, acceptedNotice, register, tenantKind, tenantDecidedAt, canChooseKind, chooseKind, registerWithInvite, createInvite, listInvites, revokeInvite, canInvite, isSolo, tenantSize, switchRole, recordEvent, eventsOf, idOfLogin, login, createSession, userOfSession, endSession, close: () => db.close() };
}
export type Auth = ReturnType<typeof openAuth>;
