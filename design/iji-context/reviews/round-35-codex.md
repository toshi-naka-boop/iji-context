critic: codex/gpt-6.1-sol xhigh

**新規の high はありません。** 前回の主要な修正は有効ですが、次の2点が残ります。

1. **[設計／medium] R17が判定できない場合も、コメント確認を委譲してしまう。**  
   [§13-2](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1849)は、R17が扱うコメントについてG05を出さないとしています。しかし、10/5の訪問診療後の急変往診に「はい」と回答し、830100086がなく、同じ請求に未対応のC001コードがある場合、R17は`partial`となり、記載漏れを`unsupportedLines`の情報不足に置き換えます（実行確認済み）。G05も黙ると、必要なコメントが不足していることを示せません。委譲は、その請求でR17が該当の記載を判定できた場合に限り、それ以外はG05の確認を残す必要があります。

2. **[設計／medium] `sameDayOf`が返す追加の問いへの切り替えが未定義。**  
   [§13-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1862)は同じ述語を使いますが、10/5の`sameDayOushinAfterVisit=false`、`sameDaySeparate`未回答では、実装は「未決・`need: sameDaySeparate`」を返します（実行確認済み）。G05の問いは引き続き`sameDayOushinAfterVisit`を保存する設計なので、述語を優先すると「いいえ」と答えても同じ問いが残ります。逆に選択肢の`means`だけで否定すると、共有述語の結果と食い違います。`need`に応じて問いを切り替えるか、G05ではこの状態を例外否定と扱う規則を明記する必要があります。
