// 外向きの通信の守り（spec FR-113）。コネクタが外へ出るときは、必ずこのファイルの connectJson を通す。
// - 接続先はリクエストから受け取らない。コネクタ id から、サーバー側の環境変数（RESEMEN_CONNECT_<ID>_URL など）を引く
// - 許可リスト RESEMEN_CONNECT_ALLOW（host:port の完全一致）にない接続先には出ない。既定は空
// - https だけ。http は「本番でない・ループバック・許可リストにある」の 3 つがそろったときだけ（同梱の模擬サーバー用）
// - リダイレクトに従わない。タイムアウト、応答サイズの上限、content-type の検査を持つ
// - 本番では、名前解決した IP がプライベート・リンクローカル・ループバックなら出ない
// - 認証情報と応答の本文を、エラー・ログに出さない（このファイルはログを書かない）
//
// 残る危険（DNS リバインディング）：名前解決の結果を検査したあと、fetch がもう一度名前解決して接続する。
// この 2 回のあいだに相手が DNS の答えを変えると、検査を通った名前で内部の IP に届きうる。
// 検査した IP に固定して接続するには fetch の下の接続処理を差し替える必要があり（依存の追加が要る）、いまは入れていない。
// 許可リストに載せるのは、DNS を自分で管理している名前か、IP の直書きに限ること（docs/connectors.md）
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type ConnectErrorKind =
  /** 設定がない・読めない（環境変数） */
  | "config"
  /** 許可されていない接続先（許可リスト外・https でない・内部の IP・接続先の範囲の外） */
  | "not_allowed"
  | "redirect"
  | "timeout"
  | "too_large"
  /** 形式違い（content-type・JSON・スキーマ） */
  | "format"
  /** 認証失敗（401・403） */
  | "auth"
  /** 相手のエラー（上のどれでもない 2xx 以外・相手が返した失敗の結果） */
  | "upstream"
  /** つながらない */
  | "network"
  | "not_found";

/** コネクタの失敗。message に入れるのは、コネクタ id・原因の種類・定型の説明だけ（URL・認証情報・応答の本文を入れない） */
export class ConnectError extends Error {
  readonly kind: ConnectErrorKind;
  readonly connectorId: string;
  /** 相手の HTTP ステータス（あれば） */
  readonly status?: number;
  constructor(connectorId: string, kind: ConnectErrorKind, detail: string, status?: number) {
    super(`コネクタ ${connectorId}: ${detail}`);
    this.name = "ConnectError";
    this.kind = kind;
    this.connectorId = connectorId;
    this.status = status;
  }
}

export type ConnectAuth = { type: "basic"; user: string; password: string } | { type: "bearer"; token: string } | null;
export type ConnectorConfig = { base: URL; auth: ConnectAuth };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const isProduction = () => process.env.NODE_ENV === "production";
const envKey = (id: string, name: string) => `RESEMEN_CONNECT_${id.toUpperCase()}_${name}`;

/** コネクタごとの設定値（環境変数 RESEMEN_CONNECT_<ID>_<NAME>）。認証情報以外の設定を読むのにも使う */
export const connectorEnv = (id: string, name: string): string | undefined => process.env[envKey(id, name)]?.trim() || undefined;

function positiveInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 許可リスト（host:port の完全一致） */
export const allowList = (): string[] =>
  (process.env.RESEMEN_CONNECT_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** コネクタ id から接続先と認証情報を引く（環境変数だけ） */
export function connectorConfig(id: string): ConnectorConfig {
  if (!/^[a-z][a-z0-9]{0,19}$/.test(id)) throw new ConnectError("?", "config", "コネクタ id が不正");
  const raw = connectorEnv(id, "URL");
  if (!raw) throw new ConnectError(id, "config", `接続先が設定されていない（${envKey(id, "URL")}）`);
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new ConnectError(id, "config", `接続先の URL が読めない（${envKey(id, "URL")}）`);
  }
  // URL に認証情報・クエリを書かせない（ログや相手の記録に残るため）
  if (base.username || base.password || base.search || base.hash) throw new ConnectError(id, "config", "接続先の URL に認証情報・クエリ・# を書かない");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const user = process.env[envKey(id, "USER")];
  const password = process.env[envKey(id, "PASSWORD")];
  const token = process.env[envKey(id, "TOKEN")];
  const auth: ConnectAuth = token ? { type: "bearer", token } : user && password ? { type: "basic", user, password } : null;
  return { base, auth };
}

const portOf = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");
const bareHost = (u: URL) => u.hostname.replace(/^\[|\]$/g, "").toLowerCase();

/**
 * 相対パス、または絶対 URL（FHIR の next リンク）を、接続先の範囲（同じ origin・同じパスの下）に解決する。
 * 範囲の外を指していれば拒否する
 */
export function resolveTarget(id: string, base: URL, target: string): URL {
  let url: URL;
  try {
    url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? new URL(target) : new URL(base.pathname + target.replace(/^[/\\]+/, ""), base.origin);
  } catch {
    throw new ConnectError(id, "not_allowed", "接続先の URL が読めない");
  }
  if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(base.pathname)) {
    throw new ConnectError(id, "not_allowed", "設定した接続先の範囲の外を指している");
  }
  return url;
}

const internal = new BlockList();
internal.addSubnet("0.0.0.0", 8);
internal.addSubnet("10.0.0.0", 8);
internal.addSubnet("127.0.0.0", 8);
// クラウドのメタデータ（169.254.169.254）を含む
internal.addSubnet("169.254.0.0", 16);
internal.addSubnet("172.16.0.0", 12);
internal.addSubnet("192.168.0.0", 16);
internal.addAddress("::", "ipv6");
internal.addAddress("::1", "ipv6");
internal.addSubnet("fc00::", 7, "ipv6");
internal.addSubnet("fe80::", 10, "ipv6");

/** プライベート・リンクローカル・ループバックの IP か（IPv4 を埋め込んだ IPv6 ::ffff:a.b.c.d も IPv4 として見る） */
export function isInternalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1] : address;
  const family = isIP(ip);
  if (family === 0) return true; // IP として読めないものは通さない
  return internal.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/** 接続してよい URL かを確かめる。だめなら not_allowed */
export async function assertAllowed(id: string, url: URL): Promise<void> {
  const host = bareHost(url);
  const key = `${url.hostname.toLowerCase()}:${portOf(url)}`;
  if (!allowList().includes(key)) throw new ConnectError(id, "not_allowed", "接続先が許可リスト（RESEMEN_CONNECT_ALLOW）にない");
  if (url.protocol !== "https:") {
    const loopbackHttp = url.protocol === "http:" && !isProduction() && LOOPBACK_HOSTS.has(host);
    if (!loopbackHttp) throw new ConnectError(id, "not_allowed", "https 以外の接続先には接続しない");
  }
  if (!isProduction()) return;
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new ConnectError(id, "network", "接続先の名前を解決できない");
  }
  if (addresses.length === 0 || addresses.some(isInternalAddress)) throw new ConnectError(id, "not_allowed", "内部のアドレス宛てには接続しない");
}

export type ConnectRequest = {
  /** 読み取りだけ。POST は、取得に POST を使う API（日レセの診療行為の取得）のためにある */
  method?: "GET" | "POST";
  /** POST の本文（JSON にして送る） */
  body?: unknown;
  /** Accept に書く値。応答の content-type もこのどれかでなければ拒否する */
  accept?: string[];
};

/**
 * コネクタの接続先から JSON を 1 つ読む。target は接続先からの相対パス（クエリつき）か、接続先の範囲の中の絶対 URL。
 * 失敗はすべて ConnectError（kind で原因が分かる）
 */
export async function connectJson(id: string, target: string, req: ConnectRequest = {}): Promise<unknown> {
  const { base, auth } = connectorConfig(id);
  const url = resolveTarget(id, base, target);
  await assertAllowed(id, url);

  const accept = req.accept ?? ["application/json"];
  const timeoutMs = positiveInt("RESEMEN_CONNECT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveInt("RESEMEN_CONNECT_MAX_BYTES", DEFAULT_MAX_BYTES);
  const headers: Record<string, string> = { accept: accept.join(", ") };
  if (auth?.type === "basic") headers.authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password}`, "utf8").toString("base64")}`;
  if (auth?.type === "bearer") headers.authorization = `Bearer ${auth.token}`;
  if (req.body !== undefined) headers["content-type"] = "application/json";

  // タイムアウトは、応答のヘッダが来るまでと本文を読み終えるまでの全体にかける
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: req.method ?? "GET",
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      redirect: "error",
      cache: "no-store",
      signal: ac.signal,
    });
    const fail = (kind: ConnectErrorKind, detail: string) => {
      void res.body?.cancel().catch(() => {});
      return new ConnectError(id, kind, detail, res.status);
    };
    if (res.status === 401 || res.status === 403) throw fail("auth", `認証に失敗した（HTTP ${res.status}）`);
    if (res.status === 404) throw fail("not_found", "相手に見つからない（HTTP 404）");
    if (!res.ok) throw fail("upstream", `相手がエラーを返した（HTTP ${res.status}）`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!accept.includes(type)) throw fail("format", "応答の content-type が想定と違う");
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw fail("too_large", "応答が上限より大きい");

    // content-length は相手の申告なので、実際に読んだ量でも数える
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new ConnectError(id, "too_large", "応答が上限より大きい", res.status);
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new ConnectError(id, "format", "応答が JSON として読めない", res.status);
    }
  } catch (e) {
    if (e instanceof ConnectError) throw e;
    // 元の例外は付けない（cause や message に URL や相手の応答が入りうる）
    if (ac.signal.aborted) throw new ConnectError(id, "timeout", "時間内に応答がなかった");
    const why = String((e as { cause?: { message?: unknown } } | null)?.cause?.message ?? "");
    if (/redirect/i.test(why)) throw new ConnectError(id, "redirect", "相手がリダイレクトを返した（従わない）");
    throw new ConnectError(id, "network", "接続できなかった");
  } finally {
    clearTimeout(timer);
  }
}

/** スキーマの検査に落ちた応答を、形式違いのエラーにする（どの項目が違うかだけを出し、値は出さない） */
export function formatError(id: string, what: string, issues: { path: PropertyKey[] }[]): ConnectError {
  const paths = [...new Set(issues.map((i) => i.path.map(String).join(".")))].slice(0, 5).join("、");
  return new ConnectError(id, "format", `${what}の形式が想定と違う（${paths || "全体"}）`);
}
