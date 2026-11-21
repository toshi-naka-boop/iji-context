// API Route の共通処理（spec FR-135・FR-136）。
// すべてのルートは route() を使う：ログイン・ロール（権限表）・回数制限・入力のスキーマを確かめてから処理に入り、
// 利用者に起因する誤り（UserError）だけ文言を返し、それ以外は 500 と定型文にする。GET 以外は監査ログに 1 行残す（docs/route-migration.md）
import { randomBytes } from "node:crypto";
import type { ZodType } from "zod";
import type { AuditResult } from "./audit";
import { SESSION_COOKIE, type User } from "./auth";
import { ConsentRequired, UserError, badRequest, forbidden } from "./errors";
import { clerkIdOf, getApp, getAuth, runAs } from "./instance";
import { permits, rolesOf, type Allowed } from "./policy";
import { clientIp, enforceLimit, limits, type LimitName } from "./rate-limit";
import { ROLE_LABELS } from "./roles";

export function cookieOf(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export const userOf = (req: Request): User | null => getAuth().userOfSession(cookieOf(req, SESSION_COOKIE));

/** セッションの cookie（httpOnly。本番は https だけで送る） */
export function sessionCookie(token: string, expires: Date): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`;
}
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

// ---------------------------------------------------------------------------
// 共通ルートヘルパ

/** それ以外の例外で返す定型文（内部のメッセージは返さない） */
export const INTERNAL_ERROR = "サーバーで問題が起きました。時間をおいて、もう一度試してください";

type Infer<S> = S extends ZodType<infer T> ? T : undefined;

export type RouteOptions<B, P, Q> = {
  /** 権限表の行。allow("POST /api/…") で引く（src/server/policy.ts） */
  roles: Allowed;
  /** JSON の本文のスキーマ（src/server/schemas/）。指定したときだけ本文を読む */
  body?: B;
  /** パスの [id] などのスキーマ。指定しなければ params は空 */
  params?: P;
  /** クエリ文字列のスキーマ。指定しなければ query は空 */
  query?: Q;
  /** 回数制限（LLM・音声のルート。config/limits.json） */
  limit?: LimitName;
  /** JSON の本文の上限（バイト）。既定は config/limits.json の jsonBytes */
  maxBytes?: number;
  /** multipart/form-data を受ける（音声など）。上限（バイト）まで読んで ctx.form に入れる */
  form?: { maxBytes: number };
  /**
   * 監査ログ。GET 以外は既定で 1 行残す（操作の名前は権限表のキー、対象は params の id）。
   * 対象の id をほかから取るときは target を渡す（本文そのものは返さない）。false は残さない（ログインなど、別に記録するルート）
   */
  audit?: false | { target?: (c: { body: Infer<B>; params: Infer<P> }) => string | null | undefined };
};

export type RouteContext<B, P, Q> = {
  req: Request;
  /** ログインした本人。roles が public のルートでは使わない（viewer を使う） */
  user: User;
  /** ログインしていれば本人、していなければ null（public のルート用） */
  viewer: User | null;
  /** tenant の中での本人の医療事務 id */
  clerkId: string;
  body: Infer<B>;
  params: Infer<P>;
  query: Infer<Q>;
  form: FormData | null;
  /** 接続元（Caddy の後ろでなければ "direct"） */
  ip: string;
};

/** スキーマに合わなければ 400 と項目名（値そのものは返さない） */
function parse<T>(schema: ZodType<T>, value: unknown, where: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const fields = [
    ...new Set(
      r.error.issues.flatMap((i) => {
        const at = i.path.map(String).join(".");
        const keys = i.code === "unrecognized_keys" ? i.keys.map((k) => (at ? `${at}.${k}` : k)) : [at || where];
        return keys;
      }),
    ),
  ];
  throw badRequest(`入力が正しくありません（項目：${fields.join("、")}）`, fields);
}

/** 上限まで読む。content-length が上限を超えていれば読まずに断り、実際に読んだ量でも確かめる */
async function readCapped(req: Request, max: number): Promise<Uint8Array> {
  const tooLarge = () => new UserError(413, "送られた内容が大きすぎます");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function readJson(req: Request, max: number): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) throw new UserError(415, "content-type は application/json にしてください");
  const bytes = await readCapped(req, max);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw badRequest("JSON として読めません");
  }
}

async function readForm(req: Request, max: number): Promise<FormData> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type)) throw new UserError(415, "content-type は multipart/form-data にしてください");
  const bytes = await readCapped(req, max);
  try {
    return await new Request(req.url, { method: "POST", headers: { "content-type": type }, body: bytes as BodyInit }).formData();
  } catch {
    throw badRequest("フォームとして読めません");
  }
}

function failure(e: unknown, action: string): { res: Response; result: AuditResult } {
  if (e instanceof UserError) {
    const result: AuditResult = e.status === 403 ? "denied" : e.status === 429 ? "limited" : e.fields || e.status === 413 || e.status === 415 ? "invalid" : "rejected";
    // 同意がまだのときは、画面が同意を出すための印を添える
    const consent = e instanceof ConsentRequired ? { consent: "required" } : {};
    return { res: Response.json({ error: e.message, ...(e.fields ? { fields: e.fields } : {}), ...consent }, { status: e.status }), result };
  }
  // 詳細はサーバーログだけに出す（本文・cookie・キーは出さない。メッセージは長さを切る）。画面には照会用の番号だけ返す
  const errorId = randomBytes(4).toString("hex");
  const err = e instanceof Error ? e : new Error(String(e));
  const where = (err.stack ?? "").split("\n").filter((l) => l.trimStart().startsWith("at ")).slice(0, 5).join("\n");
  console.error(`[api] ${action} errorId=${errorId} ${err.name}: ${err.message.slice(0, 300)}\n${where}`);
  return { res: Response.json({ error: INTERNAL_ERROR, errorId }, { status: 500 }), result: "error" };
}

/**
 * 共通ルートヘルパ。`export const POST = route({ roles: allow("POST /api/…"), body: schema }, async ({ body, user }) => …)` の形で使う。
 * handler が返した値は JSON にして返す（Response を返したらそのまま返す）。
 * 順番：ログイン → params の検証 → ロール → 注意書きへの同意 → 回数制限 → query・本文の検証 → 処理 → 監査ログ
 */
export function route<B extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined>(
  opts: RouteOptions<B, P, Q>,
  handler: (c: RouteContext<B, P, Q>) => unknown | Promise<unknown>,
) {
  const { key, rule, external, patientData } = opts.roles;
  /** 外部のサービスに送るか、患者の情報を扱うルートは、今の版の注意書きへの同意が要る（design.md §11-11。ハンドラごとには書かない） */
  const needsConsent = external !== "none" || patientData;
  return async (req: Request, routeCtx?: { params?: Promise<Record<string, string | string[] | undefined>> }): Promise<Response> => {
    if (rule === "dev" && process.env.NODE_ENV === "production") return new Response("Not Found", { status: 404 });
    const viewer = userOf(req);
    // public だけがログインなしで呼べる。dev（開発用）は、本番では上で 404、本番でなくてもログインが要る
    if (!viewer && rule !== "public") return Response.json({ error: "ログインしてください" }, { status: 401 });

    const run = async (): Promise<Response> => {
      let params = undefined as Infer<P>;
      let parsedBody = undefined as Infer<B>;
      let res: Response;
      let result: AuditResult = "ok";
      try {
        // params（対象の id）は先に確かめる。権限で断った操作も、どの対象への操作だったかを監査ログに残すため
        if (opts.params) params = parse(opts.params, (await routeCtx?.params) ?? {}, "params") as Infer<P>;
        if (viewer && !permits(rule, viewer, () => getAuth().isSolo(viewer))) {
          const need = rolesOf(rule).map((r) => `「${ROLE_LABELS[r]}」`).join("・");
          throw forbidden(need ? `この操作は${need}の役割で行います（いまの役割：${ROLE_LABELS[viewer.role]}）` : "この操作は、1 人で使っているクリニックでだけできます");
        }
        if (needsConsent && !(viewer && getAuth().acceptedNotice(viewer.id))) throw new ConsentRequired();
        if (opts.limit && viewer) enforceLimit(opts.limit, `${viewer.tenantId}:${viewer.id}`, viewer.id, getApp().dailyCounter, undefined, undefined, getAuth().dailyAll);
        const query = (opts.query ? parse(opts.query, Object.fromEntries(new URL(req.url).searchParams), "query") : undefined) as Infer<Q>;
        if (opts.body) parsedBody = parse(opts.body, await readJson(req, opts.maxBytes ?? limits().jsonBytes), "body") as Infer<B>;
        const form = opts.form ? await readForm(req, opts.form.maxBytes) : null;
        const out = await handler({ req, user: viewer as User, viewer, clerkId: viewer ? clerkIdOf(viewer) : "", body: parsedBody, params, query, form, ip: clientIp(req) });
        res = out instanceof Response ? out : Response.json(out ?? null);
      } catch (e) {
        ({ res, result } = failure(e, key));
      }
      // 監査ログ（GET 以外）。記録に失敗しても、応答は変えない
      if (viewer && opts.audit !== false && req.method !== "GET" && req.method !== "HEAD") {
        try {
          const p = params as Record<string, unknown> | undefined;
          const fallback = typeof p?.id === "string" ? p.id : typeof p?.claimId === "string" ? p.claimId : null;
          let target = fallback;
          try {
            // 検証で落ちたときは本文がないので、取れなければ params の id のままにする
            if (opts.audit && opts.audit.target) target = opts.audit.target({ body: parsedBody, params }) ?? fallback;
          } catch {}
          const app = getApp();
          app.audit.record({ userId: viewer.id, role: viewer.role, action: key, target, result, status: res.status, demoNow: app.now() });
        } catch (e) {
          console.error(`[audit] ${key} 記録に失敗: ${e instanceof Error ? e.name : "error"}`);
        }
      }
      return res;
    };
    return viewer ? runAs(viewer, run) : run();
  };
}
