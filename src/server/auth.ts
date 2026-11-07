// ログイン（spec FR-72）：ログイン ID とパスワード。パスワードは Node 標準の scrypt でハッシュにして保存し、平文は残さない。
// セッションはランダムなトークンを httpOnly の cookie で渡し、DB にはトークンのハッシュだけを置く。
// 利用者のデータは 1 人 1 クリニック（tenant）に分ける（src/server/tenant.ts）
import Database from "better-sqlite3";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

export { SESSION_COOKIE } from "./auth-cookie";
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export type User = { id: string; login: string; name: string };

const AUTH_SQL = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
`;

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
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(login)) throw new Error("ログイン ID は英数字と _ . - の 3〜32 文字にしてください");
  if (name.trim().length < 1 || name.trim().length > 20) throw new Error("名前は 1〜20 文字にしてください");
  if (password.length < 8 || password.length > 128) throw new Error("パスワードは 8 文字以上にしてください");
}

/** ログインの失敗が続いたら、しばらく受け付けない（総当たりを遅らせる。プロセスの中だけで数える） */
export class Throttle {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  blocked(key: string, now = Date.now()): boolean {
    const xs = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, xs);
    return xs.length >= this.max;
  }
  hit(key: string, now = Date.now()) {
    this.hits.set(key, [...(this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs), now]);
  }
  clear(key: string) {
    this.hits.delete(key);
  }
}

export function openAuth(dbFile: string) {
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.exec(AUTH_SQL);
  const toUser = (r: { id: string; login: string; name: string }): User => ({ id: r.id, login: r.login, name: r.name });

  function register(login: string, name: string, password: string): User {
    validateRegistration(login, name, password);
    if (db.prepare("SELECT 1 FROM users WHERE login = ?").get(login)) throw new Error("そのログイン ID は使われています");
    const id = `t${randomBytes(6).toString("hex")}`;
    db.prepare("INSERT INTO users (id, login, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, login, name.trim(), hashPassword(password), new Date().toISOString());
    return { id, login, name: name.trim() };
  }
  /** ID かパスワードが違えば null（どちらが違うかは言わない） */
  function login(loginId: string, password: string): User | null {
    const r = db.prepare("SELECT * FROM users WHERE login = ?").get(loginId) as { id: string; login: string; name: string; password_hash: string } | undefined;
    if (!r) {
      verifyPassword(password, hashPassword("dummy-password")); // 時間で ID の有無が分からないように
      return null;
    }
    return verifyPassword(password, r.password_hash) ? toUser(r) : null;
  }
  function createSession(userId: string, now = new Date()): { token: string; expires: Date } {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sha256(token), userId, expires.toISOString(), now.toISOString());
    return { token, expires };
  }
  function userOfSession(token: string | undefined, now = new Date()): User | null {
    if (!token) return null;
    const r = db
      .prepare("SELECT u.id, u.login, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
      .get(sha256(token)) as { id: string; login: string; name: string; expires_at: string } | undefined;
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
  return { register, login, createSession, userOfSession, endSession, close: () => db.close() };
}
export type Auth = ReturnType<typeof openAuth>;
