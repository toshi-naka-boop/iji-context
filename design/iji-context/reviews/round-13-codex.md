critic: codex/gpt-6.1-sol xhigh（反証 round-13。ID は台帳で X-52〜 として採番）

3件。いずれも実コードとインメモリ SQLite で再現しました。

1. **high／設計：再掲によって、提示していない外れが確認対象から抜ける。**  
   提出 S（3/5）の結果が未着のまま、3/12 に idle で要再検証へ。3/20 に確認を依頼し、3/25 に S の査定が届く。S は状態遷移前の提出なので判定では動かず、3/27 の再掲にも理由は「idle」だけが載る。しかし、3/28 の回答1では `asOf` が3/27になるため、S は以後「回答の後の外れ」にも載らない。実際に **承認済み・misses=1・まとめ空**となった。「整理までに届いた結果は見て回答した」という前提を、まとめの内容が満たしていない。  
   根拠：[理由の生成](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:345)、[再掲](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:385)、[対象の絞り込み](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:231)。

2. **high／設計：同じ提出の別種通知だけで、要再検証から停止まで進む。**  
   「回答の後の外れ」に載った S の原審査の査定へ回答2を返し、要再検証にする。その後、**同じ S・同じ区分・同じ査定**が、種類だけ「縦覧点検」として届くと、新しく採用される。v17 の `importedAt > asOf` を通り、次の整理で同じ S を根拠に停止した。受け取り時刻への切替によって、一つの提出で二段降格しない保証と §7 #5(d) が崩れている。  
   根拠：[結果の採用](/Users/toshixa/Documents/iji-context/src/lifecycle/applications.ts:137)、[対象判定](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:231)、[停止への判定](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:255)。

3. **mid／設計：整理の後に届いても、同じ時刻の結果は永久に対象外になる。**  
   3/20 の整理後に結果を取り込み、両方に同じ `now` を渡す。その後、確認項目に回答1を返すと、未提示だった結果も `importedAt === asOf` のため除外され続ける。再現結果は **承認済み・misses=1・まとめ空**。同時刻の操作は入口で許されており、ミリ秒の厳密な大小だけでは「整理で見た結果」と「整理後に届いた結果」を区別できない。取り込み順序などの境界が必要。  
   根拠：[整理時刻](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:148)、[厳密な大小比較](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:231)。


