import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Agent SDK は同梱のネイティブ CLI を実行時に解決するため、バンドルせずに読み込む
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "better-sqlite3"],
};

export default nextConfig;
