critic: codex/gpt-6.1-sol xhigh（round-84 反証 3 巡目＝上限・狭い確かめ。対象 git diff 6c36ef4..feat/v37-cdf）

X-400〜X-403 の元のケースは解消していますが、新しい退行を3件確認しました。

1. **X-410｜high｜実装（月優先で後から判明した申請を無視）** — [facts.ts:184](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/patient/facts.ts:184)  
   **11月分の「認定なし」→後から10月分の「申請中」**と登録すると、11・12月が `careLevel:0` になり、包括的支援加算に確定の `R03.not_eligible` が出ます。実行比較では `6c36ef4` は両月とも不明でした。C-530 の「申請中より前に答えた認定なしを遮断する」条件が失われています。表には逆順の組しかありません。

2. **X-411｜mid｜実装（不正な開始日を訂正できない）** — [facts.ts:163](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/patient/facts.ts:163)  
   旧行「要介護3・`2026-02-30`〜`2027-02-28`」を、開始日 `2026-03-01` で訂正しても、不正行が別キーで残ります。実行すると9・10・11月すべて不明で、旧版では3でした。表は不正な**期限**の訂正だけで、不正な**開始日**の訂正が抜けています。

3. **X-412｜mid｜実装（機関の訂正で終了月が消える）** — [page.tsx:180](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/app/uke/care-check/page.tsx:180)  
   新しい訂正経路は既存の `endMonth` を保持・送信しません。11月終了の機関で「特別の関係」だけを訂正すると、終了月が `null` になります。メモリSQLiteで実行し、12月の有効機関が0件→1件となり、12月の `C007` に誤った条件つき `R21.shiji` が出ることを確認しました。

既存の月優先テスト14件は通過。上記の未収載ケースは、ファイルを変更せず実コードで実行しました。


