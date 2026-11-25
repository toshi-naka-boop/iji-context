import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

// CSP（spec FR-143）は強制（Content-Security-Policy）。報告だけのモードで、全画面（開発時と本番のビルド）に違反がないことを確かめてから切り替えた。
// - script：Next.js は画面の初期データをインラインの script で流す。nonce 方式は全ページを動的レンダリングにする必要があるので、
//   'unsafe-inline' を許す（静的に出している画面を動的にしないため。残余リスクは docs/security.md）。開発時だけ 'unsafe-eval'（React の開発用の機能）
// - style：画面が style 属性（インライン）を使っている。Google Fonts の CSS を読む
// - img：画面の画像は public/characters/ のものだけ（カルテの画像は読み取って API に送るだけで、画面には出さない）
// - connect：画面からの通信は自分の API だけ（LLM・音声の API はサーバーから呼ぶ。ElevenLabs へ画面から直接はつながない）
// - media：音声は API から受け取ったバイト列を AudioContext で再生する（audio・video の要素は使わない）
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self'",
  "media-src 'self'",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// 静的なセキュリティヘッダ。前段の Caddy（deploy/Caddyfile）も同じ名前のヘッダを同じ値で付ける（二重になっても意味は変わらない値にそろえてある）
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // マイクは初回のあいさつの音声入力で使う（自分の画面だけ）
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Content-Security-Policy", value: csp },
];

const nextConfig: NextConfig = {
  // Agent SDK は同梱のネイティブ CLI を、SQLite（暗号化つきのものを含む）はネイティブのアドオンを実行時に解決するため、バンドルせずに読み込む
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "better-sqlite3", "better-sqlite3-multiple-ciphers"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
