critic: codex/gpt-6.1-sol xhigh

解消済みの指摘を除き、4件あります。**新規 high は2件です。** §14は未実装のため、設計と既存コードの静的レビューです。

1. **[設計/high] 修正版が、修正前の向き・条件で再利用される。**  
   ベテラン層を参照する修正は入っていますが、既存の [`ensureCandidate`](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/lifecycle/review.ts:625) は修正内容を本文へ書き、`polarity`・`conditionNote` は元からコピーします。一方、[§14-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1962) のG05入力には本文がありません。返戻後に「この条件では併算定不可」と修正して承認しても、元の`allow`と条件が候補として表示され、確認ボタンで指摘を消せます。修正版の承認前に、この二項目を修正する経路が必要です。

2. **[前提/high] 実在請求の返戻が、既存の通知登録入口で止まり、棚卸につながらない。**  
   [§14-4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1970) は既存の`registerNotice`を使いますが、[現行入口](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/server/app/knowledge.ts:64) の患者照合元は同梱の`fixtures/uke/patients.json`です。[照合失敗](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/notice/notice.ts:99)は候補作成で拒否されます。アップロードした実在請求を院内知識で通した後、その患者の返戻通知を登録しても拒否され、棚卸を起こせません。取り込み済み請求への照合拡張と、候補作成の成否に依存しない棚卸経路が必要です。

3. **[設計/medium] 同時・1週間の表で、確認記録の単位が未定義。**  
   [§14-1](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1931) は`tani=3・4`も対象ですが、[確認記録のdate](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1958) は1日・同一月の表しか定めていません。同時の表で同じ組を3日と15日に算定し、3日だけ条件を満たすケースを区別する規則がありません。請求単位の確認として保存すると15日分まで消えます。両表の確認範囲・保存キーを定義する必要があります。

4. **[設計/medium] `avoid`を使い続けても、使用記録が更新されない。**  
   [§14-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1958) の`USED`は`allow`の確認ボタン経路だけです。`avoid`の助言に従って毎月請求を直しても、近似なので提出結果から数えられず、メンターにも渡りません。そのため180日後には使用中の知識がidleで要再検証になります。`avoid`を使ったことを記録する経路も必要です。
