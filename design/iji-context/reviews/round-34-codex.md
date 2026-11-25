critic: codex/gpt-6.1-sol xhigh

**新規の high はありません。ただし、前回 high の C-108 は一部未解消です。** 解決済みの論点を除き、4件あります。

1. **[設計/high] C-108：R09への委譲では、C001算定の要件が残る。**  
   [§13-2](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1849)はR09が無指摘ならG05を消します。しかし、10/10・10/22に往診、10/22死亡、15日間にC001算定なしという入力でも、現行R09は指摘0でした（実行確認）。訪問の実施回数とC001の算定は別であり、[留意C000(12)](https://www.mhlw.go.jp/content/12400000/001757385.pdf#page=246)の条件を確認できていません。未確認の要件を残すか、委譲先の点検範囲を広げる必要があります。

2. **[設計/medium] 「判定不能」への変更で、以前の真偽値が失効しない。**  
   [§13-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1860)では、判定不能なら共有事実を書かず、別キーに記録します。例えば10/5の回答を「はい」から判定不能へ訂正しても、保存済みの`sameDayOushinAfterVisit=true`が残り、R10は以前の値を読み続けます。G05だけ別キーを優先しても両者が食い違います。両キーをまたぐ失効・優先順位の規則が必要です。

3. **[設計/medium] 同日の複数の組に、異なる回答を保存できない。**  
   [回答の保存単位](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1823)は事実キーと日付だけで、コード組や実施単位を含みません。例えば、同日の簡易培養が「尿の培養とは別検体、喀痰の培養とは同一検体」という請求で、両組が同じHXを参照すると、尿側への「例外に当たる」が喀痰側にも効き、指摘を消せます。[検体による例外](/Users/toshixa/Documents/iji-context/design/iji-context/sources/research/tokurei-group4.md:212)には、組・実施を区別する回答範囲が必要です。

4. **[設計/medium] 日付のないコメントに、同日の存在確認を要求している。**  
   [§13-2](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1848)は`scope=day`なら同日コメントを要求しますが、[§11-5](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1356)では830100086の日付対応を取れないと明記しています。10/5・10/20の両方について理由をCOで2件記載した正しい請求でも、各日の充足を判定できません。既存の件数照合、またはR17への委譲にそろえる必要があります。
