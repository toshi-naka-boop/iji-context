critic: codex/gpt-6.1-sol xhigh（反証 round-14。ID は台帳で X-55〜 として採番）

2件です。どちらもメモリ上で再現しました。

1. **高／設計：制度層から作る修正版候補が、関係する査定でも止まらない。**  
   R01の`recheck`回答2で作ったベテラン層の候補を承認すると、`match`は`{ruleId:"R01"}`を引き継ぎます。しかし、査定との関係判定は制度層以外では`kubunAll`だけを参照します。そのため、R01の対象区分C002が査定されても「関係なし＝当たり」になり、候補の使用が続きます。再現結果は`held=[]`、承認済み、hits=1でした。修正版にも照合対象の区分を持たせる契約が欠けています。  
   根拠：[候補生成](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:482)、[関係判定](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:65)。

2. **中／実装：途中で失敗した整理が、未回答のまとめを隠し、次の確認日の判定も抑止する。**  
   `confirmationReview`は処理開始時に`reviews`へ記録し、`buildDigest`はその最新行だけを参照します。3月の未回答項目がある状態で、4月10日の整理をまとめ作成直前に停止すると、未回答項目はDBに残っているのにまとめは空になります。さらに最新の`ranAt`を`dueConfirmation`へ渡すと、4月11日はfalseとなり、通常の時計操作では5月まで確認を再開できません。これは§8で許容した外れの重複・取りこぼしとは別の、整理全体の復旧漏れです。  
   根拠：[開始時の記録](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:195)、[最新行だけを使うまとめ](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:394)。


