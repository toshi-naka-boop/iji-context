// scrypt（パスワードのハッシュ）を使うテストは、並列で走ると既定の 5 秒を超えることがある
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { testTimeout: 20_000 },
  // テストが DB の中身を確かめるために開く better-sqlite3 は、アプリと同じ SQLite のライブラリ（src/db/open.ts）に向ける。
  // 1 つのプロセスに SQLite が 2 つ入ると、同じファイルの WAL とロックを互いに見られない（片方の書き込みが、もう片方から見えない）
  resolve: { alias: [{ find: /^better-sqlite3$/, replacement: "better-sqlite3-multiple-ciphers" }] },
});
