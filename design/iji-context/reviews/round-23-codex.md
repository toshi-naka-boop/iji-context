critic: codex/gpt-6.1-sol xhigh（指摘 X-83・X-84）

tokens used
143,821
1. **high／設計：追加した `bundles` が、コードの網羅性検査・書き出し禁止規則と両立しない。**  
   [§11-1](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1195)は全区分を `codes`／`uncoded` の二択とし、後者の書き出しを禁止しています。一方、[追加した包括検査の経路](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1200)は単独コードのない `D007_10` を `bundles` で扱います。**具体例：**記録条件仕様の確認に成功しても、K1 の `D007_10` を `uncoded` に残せば書き出し例外、外せば網羅性検査で失敗します。`bundles` を第三の対応方法として、検査・読み書き・完了条件に通す規則が必要です。

2. **high／設計：C-82 の「片方の版にない手入力行」の問題が未解消。**  
   [§11-2 の改訂](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1254)は新設区分を「導出しない」としていますが、電子的診療情報連携体制整備加算は手入力対象です。現実装は [`input.manual` をそのまま結果に追加](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/derive.ts:349)します。**具体例：**同加算を手入力して確定した請求を比較すると、令和6年度側にも行が残り、点数取得で「未知の区分」の例外になります。版に存在しない手入力行を比較でどう扱うかは、導出の抑止とは別に定義する必要があります。


