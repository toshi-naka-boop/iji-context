critic: codex/gpt-6.1-sol xhigh（round-83 反証 2 巡目・狭い確かめ。対象 git diff 6f89f35..feat/v37-cdf）

1. **X-400｜high｜実装（認定月の優先・C-530 未解消）** — [facts.ts:178](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/patient/facts.ts:178)  
   「申請中〔10月分〕」の後に、過去の「認定なし〔9月分〕」を登録すると、11月が `careLevel:0` に戻り、包括的支援加算に確定の `R03.not_eligible` が出ます。切断条件の `j > i` が追記順だけを見るためです。9月の回答で10月の申請を解消しないよう、回答月も比較する必要があります。

2. **X-401｜high｜実装（既存不正値への対処による誤判定）** — [facts.ts:151](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/patient/facts.ts:151)  
   「認定なし〔9月分〕」の後に、旧版で保存できた要介護3〔開始 `2026-10-01`、期限を `2027-02-30` と誤入力〕があると、今回の除外処理で古い「認定なし」が復活します。11月が `careLevel:0` となり、確定の `R03.not_eligible` を再現しました。不正な認定は不明として訂正を促し、古い値へ確定させない必要があります。

3. **X-402｜mid｜実装（再確認経路・C-541／X-391 未解消）** — [page.tsx:176](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/app/uke/care-check/page.tsx:176)  
   在医総管を取る側が「分からない」の患者カードは戻りますが、再回答は `instId` を送らず、同名でも別機関として追加されます。「当院」と答え直しても旧機関の不明値が効き続け、`notDone:true` のままでした。既存機関への訂正を同じ画面から残せる経路が必要です。

4. **X-403｜low｜実装（聞き取り対象の過剰化）** — [app.ts:291](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/server/app.ts:291)  
   全活動の「分からない」を対象判定に使っています。管理料の請求で取る側が「当院」と確定していても、未使用の「在がん総診」などが不明なら、`notDone:false・notes:[]` なのに `asks:["others"]` が残ります。§18-2 の C-514 に従い、その請求の場面で読む項目だけを対象にする必要があります。


