// ログインの auth.db のハンドル（プロセスに 1 つ）。src/server/instance.ts と、外部へ送る処理（src/llm/outbound.ts）の両方が使うので、小さなファイルに分けてある
import path from "node:path";
import { openAuth, type Auth } from "./auth";

/** データの置き場所（本番はディスクを付けた場所を RESEMEN_DATA で渡す） */
export const dataDir = () => path.resolve(process.env.RESEMEN_DATA ?? path.join(process.cwd(), "data"));

let auth: Auth | null = null;
export function getAuth(): Auth {
  auth ??= openAuth(path.join(dataDir(), "auth.db"));
  return auth;
}
