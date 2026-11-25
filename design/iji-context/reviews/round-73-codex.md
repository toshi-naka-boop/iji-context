critic: codex/gpt-6.1-sol xhigh（v36 実装の反証）

5件です。合成入力とメモリDBで再現しました。リポジトリ直下の `*.UKE` は開いていません。

1. **X-320／P2／実装：関連テーブル未導入だと形式チェックも止まる**  
   [形式チェックの入口](/Users/toshixa/Documents/iji-context/.claude/worktrees/e-v36/src/generic/g07.ts:249)より前に、`evaluateGeneric` の準備判定で停止します。関連表なし・G07未準備のDBへ `851100038 / 2460` を渡すと、直接実行では `G07.form` が1件、通常経路では0件です。§17-3の「関連テーブルがなくても動く」を満たしません。

2. **X-321／P2／実装：別のコメント行への注意まで重複として消す**  
   [重複除外](/Users/toshixa/Documents/iji-context/.claude/worktrees/e-v36/src/generic/overlap.ts:119)が行ではなく、R17の規則とコードで判断しています。2026年10月の在医総管に、同じコード `850100106` で不正日付 `5081332` と未来日付 `5081101` を置くと、前者へのR17形式指摘によって、後者の `G07.form_future` も消えます。§17-3が求める「同じコメントの行だけ」の除外になっていません。

3. **X-322／P2／設計：記載値が判定履歴へ複製される**  
   [指摘の値](/Users/toshixa/Documents/iji-context/.claude/worktrees/e-v36/src/generic/g07.ts:230)に文字データ全文を入れるため、査定・返戻の突き合わせでその指摘を選び「判定を残す」と、[履歴保存](/Users/toshixa/Documents/iji-context/.claude/worktrees/e-v36/src/server/app/review.ts:317)が `review_judgments.finding` に値ごと保存します。合成の目印文字列で確認しました。氏名等が誤入力されていれば、それも残ります。表示する値と履歴へ残す情報の扱いが設計に欠けています。

4. **X-323／P2／実装：実物検証用の集計が200件で過少計数する**  
   [集計処理](/Users/toshixa/Documents/iji-context/.claude/worktrees/e-v36/scripts/count-kisai.ts:49)は、表示用に上限200件へ切られた `findings` を数え、`omitted` を無視します。不正時刻コメント201件で、G07本体は201件、集計対象は200件になりました。§17-6(6)の検証件数として使えません。

5. **X-324／P3／実装：別表Ⅱ・Ⅳの条件付き項目にリンクが付かない**  
   [リンク生成](/Users/toshixa/Documents/iji-context/.claude/worktrees/e-v36/src/generic/g07.ts:152)が同じ別表の要旨からURLを探しますが、現版の要旨は別表Ⅰだけです。別表Ⅱの00行を置くと `source: {}` になりました。§17-1で必須とした、利用者が条件を確かめるための別表リンクが欠落します。

外部送信・監査ログへの漏出、確定の誤検出、追加の過剰実装は確認できませんでした。


