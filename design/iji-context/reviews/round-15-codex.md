critic: codex/gpt-6.1-sol xhigh（反証 round-15。ID は台帳で X-57〜 として採番）

許容事項・解決済み論点を除き、3件です。いずれも実コードを、保存先をメモリに置き換えて再現確認しました。

1. **重大度 high／設計：修正版が改定・改選の見直し対象から外れる**  
   修正版は元の層にかかわらずベテラン層になりますが、ベテラン層には改定・改選トリガーがありません。制度知識を修正し、原本を保管、修正版を承認した後、引用され続けて idle も成立しないと、次の制度改定でも修正版は承認済みのまま、会議の確認対象に入りません。再現でも2026年6月の改定後に議題は空でした。責任者が判断する機会が欠けます。  
   根拠：[候補の層を固定する設計](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:364)、[層別トリガー](/Users/toshixa/Documents/iji-context/src/lifecycle/layers.ts:15)。

2. **重大度 mid／実装：議題から消えた古い `miss` の回答で知識を降格できる**  
   査定を載せた会議の後、結果が通過に訂正され、次の会議では外れがなくなっても、旧項目への回答2が反映されます。`reflect` は知識の snapshot だけを照合し、当該外れ・項目が現在も有効か確認しません。再現では議題が空なのに、旧回答によって承認済み→要再検証となり候補も作られました。§4-4 の「今回載らなかった旧項目への回答は記録だけ」に反します。  
   根拠：[旧項目の失効規則](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:323)、[回答時の照合](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:547)。

3. **重大度 mid／実装：完成済みの一時ディレクトリが残ると、以後の会議が毎回失敗する**  
   候補作成で一時ディレクトリの `meta.json` を書き終え、正式名への rename 前に中断すると、`listKnowledge` が `.tmp-*` も正式な知識として読みます。その meta の id は未作成の正式パスを指すため、会議の数え直しが「知識が見つからない」で停止します。実際の rename 直前で中断させると、再実行しても翌週の会議でも同じ例外になりました。meta のない残骸とは別の、完成済み一時領域の走査漏れです。  
   根拠：[一時領域への保存](/Users/toshixa/Documents/iji-context/src/lifecycle/store.ts:136)、[一時領域も拾う走査](/Users/toshixa/Documents/iji-context/src/lifecycle/store.ts:160)。


