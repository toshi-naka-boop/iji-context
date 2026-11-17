// scrypt（パスワードのハッシュ）を使うテストは、並列で走ると既定の 5 秒を超えることがある
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { testTimeout: 20_000 } });
