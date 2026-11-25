// Origin の検証（spec FR-138）：GET 以外の /api/ へのリクエストは、自分の画面から来たものだけを受ける（CSRF 対策）。
// proxy.ts から読むので、Node 専用のものを読み込まない小さなファイルに分ける

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/** 環境変数 RESEMEN_ALLOWED_ORIGINS（カンマ区切りの Origin。例 https://example.com）で、Host 以外に許す Origin を足せる */
export const allowedOrigins = (): string[] =>
  (process.env.RESEMEN_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);

export type OriginCheck = { method: string; pathname: string; origin: string | null; host: string | null; secFetchSite: string | null; allowed?: string[] };

/**
 * 受けてよいリクエストか。
 * - Origin があれば、その host がリクエストの Host と同じか、環境変数で許した Origin のときだけ受ける
 *   （前段の Caddy が https を受けてアプリには http で渡すので、スキームではなく host で比べる。"null" は受けない）
 * - Origin がなければ Sec-Fetch-Site を見る（same-origin と、利用者が自分で開いた none だけ受ける）
 * - どちらもないのは、ブラウザではないクライアント（curl・スクリプト）。ブラウザは GET 以外のリクエストに必ず Origin を付けるので、
 *   どちらもないリクエストは、他人のブラウザを踏み台にした攻撃（CSRF）ではない。cookie を持っているなら本人が自分で送っているので受ける
 */
export function originAllowed(c: OriginCheck): boolean {
  if (SAFE_METHODS.includes(c.method.toUpperCase()) || !c.pathname.startsWith("/api/")) return true;
  if (c.origin !== null) {
    if ((c.allowed ?? allowedOrigins()).includes(c.origin)) return true;
    try {
      return c.host !== null && new URL(c.origin).host === c.host;
    } catch {
      return false;
    }
  }
  if (c.secFetchSite !== null) return c.secFetchSite === "same-origin" || c.secFetchSite === "none";
  return true;
}
