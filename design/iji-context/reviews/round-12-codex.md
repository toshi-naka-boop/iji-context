critic: codex/gpt-6.1-sol xhigh（反証 round-12。ID は台帳で X-47〜X-51 として採番）

5件です。いずれも実装をインメモリで動かして再現しました。

1. **high／設計：項目の再掲で、未着の結果が確認対象から抜ける。**  
   3/20に `recheck` を作成し、3/21に提出S、結果未着のまま3/27に同じ項目を再掲、3/28に回答1。その後Sの査定が届いても、`asOf` が3/27へ進んでいるためSは対象外となり、「回答の後の外れ」にも載りません。§4-4の「整理より前の提出は判定済み」という前提が、未着結果について成立しません。該当：[項目の再利用](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:369)、[asOfの設定](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:598)。

2. **high／設計：回答2の拾い直し直後、同じ整理で再承認される。**  
   3/27の「回答の後の外れ」に対する回答2を3/29に記録し、反映前に停止。その間に、3/28提出のS2へ通過が届くと、4/3の整理は手順0で承認済み→要再検証、手順1でS2を使って承認済みに戻します。`asOf=3/27` がS2を通すためです。「1回の整理で1段まで」と、回答2後に要再検証として確認する規定が崩れます。該当：[拾い直し](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:162)、[通過による再承認](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:259)。

3. **medium／実装：修正版の候補から近似条件が失われる。**  
   `matchApprox=true`、`conditionNote="月2回以上の訪問時だけ"` の知識について回答2を反映すると、候補は同じ `match` を持ちながら `matchApprox=false`、`conditionNote=null` になります。候補を承認すると、訪問回数を判定できない条件のまま提出結果で自動遷移します。§3の近似知識に対する制限に反します。該当：[候補の生成](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:555)。

4. **medium／設計：「回答の後の外れ」は区分が訂正されても古い回答が通る。**  
   提出SのC001査定をまとめに載せた後、結果がC002査定へ訂正されても、snapshotには提出IDしか加えていないため、古いC001の問いへの回答1が反映されます。さらにS全体が確認済みになり、未確認のC002の外れも以後表示されません。該当：[snapshot](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:298)、[確認済み提出の除外](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:207)。

5. **medium／実装：storeが不正なBasis.asOfを保存し、後続の整理が停止する。**  
   有効な `now` と日付だけの `basis.asOf="2025-03-03"` を `applyEvent` に渡すと、入口で拒否されず保存されます。その後の `weeklyReview` は基準時刻の解析で例外となり、整理全体が進みません。§3で要求した入口検証が `now` 以外に及んでいません。該当：[保存処理](/Users/toshixa/Documents/iji-context/src/lifecycle/store.ts:179)、[基準時刻の解析](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:222)。


