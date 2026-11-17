// 外向きの通信の守り（spec FR-113）。コネクタが外へ出るときは、必ずこのファイルの connectJson を通す。
// - 接続先はリクエストから受け取らない。コネクタ id から、サーバー側の環境変数（RESEMEN_CONNECT_<ID>_URL など）を引く
// - 許可リスト RESEMEN_CONNECT_ALLOW（host:port の完全一致）にない接続先には出ない。既定は空
// - https だけ。http は「本番でない・ループバック・許可リストにある」の 3 つがそろったときだけ（同梱の模擬サーバー用）
// - リダイレクトに従わない。タイムアウト、応答サイズの上限、content-type の検査を持つ
// - 名前解決は 1 回だけ行い、その結果の IP にそのまま接続する（検査と接続のあいだに DNS の答えを差し替えられても届かない）。
//   本番では、その IP がプライベート・リンクローカル・ループバックなどの内部アドレスなら出ない
// - 認証情報と応答の本文を、エラー・ログに出さない（このファイルはログを書かない）
//
// 接続には node:https（本番でないループバックだけ node:http）の request を使い、検査済みの IP を返す lookup を渡す。
// 接続先のホスト名は元のまま渡すので、TLS の証明書の検証・SNI・Host ヘッダは元のホスト名で働く。
// グローバルの fetch は使わない（接続先の IP を固定するには undici の Agent が要るが、Node 同梱の undici は import できず、依存の追加になるため）
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

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
// キャリアグレード NAT
internal.addSubnet("100.64.0.0", 10);
internal.addSubnet("127.0.0.0", 8);
// クラウドのメタデータ（169.254.169.254）を含む
internal.addSubnet("169.254.0.0", 16);
internal.addSubnet("172.16.0.0", 12);
internal.addSubnet("192.168.0.0", 16);
// ネットワーク機器の試験用
internal.addSubnet("198.18.0.0", 15);
// マルチキャスト・予約済み
internal.addSubnet("224.0.0.0", 4);
internal.addSubnet("240.0.0.0", 4);
internal.addAddress("::", "ipv6");
internal.addAddress("::1", "ipv6");
// IPv4 を埋め込む NAT64（宛先の IPv4 を検査できないので、まとめて通さない）
internal.addSubnet("64:ff9b::", 96, "ipv6");
internal.addSubnet("fc00::", 7, "ipv6");
internal.addSubnet("fe80::", 10, "ipv6");
internal.addSubnet("ff00::", 8, "ipv6");

/** プライベート・リンクローカル・ループバック・マルチキャスト・予約済みの IP か（IPv4 を埋め込んだ IPv6 ::ffff:a.b.c.d も IPv4 として見る） */
export function isInternalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1] : address;
  const family = isIP(ip);
  if (family === 0) return true; // IP として読めないものは通さない
  return internal.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/** 名前解決（テストで差し替えられるように、オブジェクトの口にしてある）。ホスト名 → IP の一覧 */
export const dnsResolver = {
  resolve: async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((a) => a.address),
};

/**
 * 接続してよい URL かを確かめ、接続する IP を 1 つ返す。だめなら not_allowed。
 * 名前解決はここで 1 回だけ行う。返した IP にそのまま接続するので、このあとで DNS の答えが変わっても接続先は変わらない
 */
export async function assertAllowed(id: string, url: URL): Promise<string> {
  const host = bareHost(url);
  const key = `${url.hostname.toLowerCase()}:${portOf(url)}`;
  if (!allowList().includes(key)) throw new ConnectError(id, "not_allowed", "接続先が許可リスト（RESEMEN_CONNECT_ALLOW）にない");
  if (url.protocol !== "https:") {
    const loopbackHttp = url.protocol === "http:" && !isProduction() && LOOPBACK_HOSTS.has(host);
    if (!loopbackHttp) throw new ConnectError(id, "not_allowed", "https 以外の接続先には接続しない");
  }
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await dnsResolver.resolve(host);
  } catch {
    throw new ConnectError(id, "network", "接続先の名前を解決できない");
  }
  if (addresses.length === 0 || addresses.some((a) => isIP(a) === 0)) throw new ConnectError(id, "network", "接続先の名前を解決できない");
  // 答えのどれか 1 つでも内部アドレスなら出ない（どれに接続するかを相手に選ばせない）
  if (isProduction() && addresses.some(isInternalAddress)) throw new ConnectError(id, "not_allowed", "内部のアドレス宛てには接続しない");
  return addresses[0];
}

/** 何を聞かれても、検査済みの IP だけを返す lookup（node:http・node:https の request に渡す） */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

export type ConnectRequest = {
  /** 読み取りだけ。POST は、取得に POST を使う API のためにある */
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
  const address = await assertAllowed(id, url);

  const accept = req.accept ?? ["application/json"];
  const timeoutMs = positiveInt("RESEMEN_CONNECT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveInt("RESEMEN_CONNECT_MAX_BYTES", DEFAULT_MAX_BYTES);
  const body = req.body === undefined ? null : Buffer.from(JSON.stringify(req.body), "utf8");
  const headers: Record<string, string | number> = { accept: accept.join(", ") };
  if (auth?.type === "basic") headers.authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password}`, "utf8").toString("base64")}`;
  if (auth?.type === "bearer") headers.authorization = `Bearer ${auth.token}`;
  if (body) Object.assign(headers, { "content-type": "application/json", "content-length": body.byteLength });

  // タイムアウトは、接続・応答のヘッダ・本文を読み終えるまでの全体にかける
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      // hostname は元のホスト名のまま（証明書の検証・SNI・Host ヘッダに使われる）。接続する IP だけを lookup で固定する。
      // agent: false で毎回新しい接続にする（別の IP に張られた接続を使い回さない）。リダイレクトには従わない（request は従わない）
      const r = (url.protocol === "https:" ? https : http).request({
        protocol: url.protocol,
        hostname: bareHost(url),
        port: portOf(url),
        path: url.pathname + url.search,
        method: req.method ?? "GET",
        headers,
        lookup: pinnedLookup(address),
        agent: false,
        signal: ac.signal,
      });
      r.once("response", resolve).once("error", reject);
      r.end(body ?? undefined);
    });
    const status = res.statusCode ?? 0;
    const fail = (kind: ConnectErrorKind, detail: string) => {
      res.destroy();
      return new ConnectError(id, kind, detail, status);
    };
    if (status >= 300 && status < 400) throw fail("redirect", "相手がリダイレクトを返した（従わない）");
    if (status === 401 || status === 403) throw fail("auth", `認証に失敗した（HTTP ${status}）`);
    if (status === 404) throw fail("not_found", "相手に見つからない（HTTP 404）");
    if (status < 200 || status >= 300) throw fail("upstream", `相手がエラーを返した（HTTP ${status}）`);
    const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!accept.includes(type)) throw fail("format", "応答の content-type が想定と違う");
    if (Number(res.headers["content-length"] ?? "0") > maxBytes) throw fail("too_large", "応答が上限より大きい");

    // content-length は相手の申告なので、実際に読んだ量でも数える
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw fail("too_large", "応答が上限より大きい");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new ConnectError(id, "format", "応答が JSON として読めない", status);
    }
  } catch (e) {
    if (e instanceof ConnectError) throw e;
    // 元の例外は付けない（cause や message に接続先や相手の応答が入りうる）
    if (ac.signal.aborted) throw new ConnectError(id, "timeout", "時間内に応答がなかった");
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
