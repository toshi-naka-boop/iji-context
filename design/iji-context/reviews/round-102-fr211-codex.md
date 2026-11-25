critic: codex/gpt-6.1-sol xhigh（round-102 狭い確かめ）

X-510 は解消。X-511 は未解消です。2件あります。

1. **X-520｜Major｜実装・未解消：確定後の医師訂正を事務が読めない**  
   [回答の再取得](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/app/chart/acts-review.tsx:116)は未確定画面の表示時だけです。[確定すると表示自体が消え](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/app/chart/page.tsx:256)、既存カルテから開き直す入口もありません。「医師確認へ回す→確定→後で医師が訂正」の通常経路では、追加した回答表示に到達できず、X-511 が残ります。

2. **X-521｜Major｜実装・回帰：確認依頼を外すと受領済みの医師訂正も消える**  
   [doctorAnswerOf](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/src/server/app/doctor-abbrevs.ts:135)が、最新の `askDoctor:false` を除外する `items()` 経由で回答を探しています。Lv.5 の事務が AMI＝心筋梗塞を選択→医師が心臓破裂と回答→事務が「医師確認に回す」を外して保存すると、`doctorAnswer:null` となり、[meaning も心筋梗塞へ戻ります](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/src/server/app/notes.ts:165)。実メソッドとメモリ DB で再現し、回答記録自体は残存しています。
