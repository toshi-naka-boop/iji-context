critic: codex/gpt-6.1-sol xhigh（反証 round-16。ID は台帳で X-60〜 として採番）

3件。いずれも実ファイルを変更せず、メモリ上で再現しました。

1. **重大度：高／種別：実装 — 修正版を、改定前の回答で改定後に再承認できる。**  
   トリガーは元の層を継承しますが、回答照合の `basisDate` は自身の層だけを見るため、ベテラン層の修正版では `null` です。制度知識の修正版が2026年5月30日に idle で要再検証となり、その recheck に6月2日に回答1を返すと、6月1日の改定をまたいでも承認済みに戻ります。`status_since` も改定後になるため、次の会議でも改定トリガーが発火せず、見直しを抜けたまま使用が再開します。[review.ts:214](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:214)、[triggers.ts:38](/Users/toshixa/Documents/iji-context/src/lifecycle/triggers.ts:38)

2. **重大度：高／種別：実装 — 回答できなくなった古い miss が、recheck を待機させ続ける。**  
   待ち対象の miss は `status_since` だけで結び付け、古い snapshot や最新会議から外れた項目も含めます。制度知識が要再検証のまま改定日をまたぐと、新しい snapshot の miss が作られます。その新しい miss に回答1を反映しても、未回答の古い miss が残るため、recheck の回答1は `held` になります。次の会議では外れは扱い済みなので miss が消え、待機中なので recheck も出ません。**全議題が消え、責任者が回答しても要再検証から戻せなくなります。** 外れが通過へ訂正された場合にも同じ停止を再現しました。[review.ts:574](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:574)、[review.ts:365](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:365)

3. **重大度：中／種別：実装 — 回答保存直後の中断で、最新会議の照合が復旧時に抜ける。**  
   v21で回答時へ移した最新会議チェックは、回答のDB保存より後にあります。訂正によって最新議題から消えた古い miss に回答2が届き、保存直後・チェック前に中断すると、次回の拾い直しは `reflect` へ直接進みます。そこには最新会議のチェックがないため、古い回答が反映され、承認済みの知識が要再検証へ下がり、修正候補まで作られます。[review.ts:498](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:498)、[review.ts:178](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:178)、[review.ts:569](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:569)


