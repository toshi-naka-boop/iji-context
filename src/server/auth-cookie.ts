// セッションの cookie の名前（proxy.ts からも読むので、Node 専用のものを読み込まない小さなファイルに分ける）
// 本番は __Host- を付ける（Secure・Path=/・Domain なしの cookie だけをブラウザが受け取る。別のサブドメインから上書きされない）。
// 手元の開発は http なので付けない（__Host- は Secure が要る）
export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-resemen_session" : "resemen_session";
