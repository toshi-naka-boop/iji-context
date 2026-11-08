critic: codex/gpt-6.1-sol xhigh（批評 round-5、v7。2026-11-04）

codex
新しい **high は1件**あります。以下は Codex による直接批評です。解決済み論点との重複を避け、重大度順に5件挙げます。

1. **high／設計 — 「当たり→なし→外れ」で、再承認の根拠が覆っても承認済みのままになる**  
   [§4-4 手順5・変換表](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:284)  
   破綻シナリオ：要再検証の allow 知識に対して、同じ提出の結果が「通過→関係のない返戻→関係のある査定」と届く。最初の通過で承認済みになり、返戻で効果は「なし」、査定で「外れ」になる。しかし訂正による降格条件は「当たり→外れ」だけなので、最後も承認済みに残ります。「通過→査定」なら要再検証になるため、中間の返戻だけで安全上の結果が変わります。**C-18 対応の不足**で、§7 #5 にこの経路が必要です。

2. **medium／設計 — 旧 rev の訂正が、修正済みの知識を降格・停止させられる**  
   [§4-4 手順5〜7](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:285)  
   破綻シナリオ：r1 は「コメントなしでも通る」、r2 は条件を修正して「コメント付きなら通る」とし、ベテランが再承認する。その後、r1 時代のコメントなし請求が「通過→査定」に訂正されると、現在の r2 が要再検証へ進み、既に要再検証なら停止します。この査定は r2 の反例ではありません。訂正経路には適用記録との rev 一致条件がなく、現在の状態を使ったイベント guard だけでは防げません。**C-18 の修正で追加された経路の問題**です。§7 #5 の rev 検証も、再承認の禁止だけを確認しています。

3. **medium／設計 — 「記録だけ」にした回答2が、数え直しで外れとして復活する**  
   [数え直し](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:283)・[回答の反映条件](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:317)  
   破綻シナリオ：問い合わせ後に知識が別の状態へ移り、回答2は照合不一致で記録だけになる。その後、別の提出結果を取り込むと、手順4の「ベテランの回答2の件数」に含まれ、misses が増えます。`veteran_queries` には回答を実際に反映したかを保存する列がなく、有効な回答と記録だけの回答を集計時に区別できません。反映済みの効果を保存し、その分だけ数える必要があります。

4. **medium／設計 — 内容一致で無視した resultId の再送が、後の訂正を上書きする**  
   [§4-4 手順1](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:280)  
   破綻シナリオ：R1＝通過を取り込み、別 ID の R2＝同内容の通過を「何もしない」で捨て、その後 R3＝査定を取り込む。R2 が再送されると、ID は未記録で現在の内容とも違うため、新しい通過として採用されます。単なる再送で misses が消え、last_hit_at も更新されます。**X-17 対応の不足**で、効果を更新しない場合も受信済み resultId は保存する必要があります。

5. **low／設計 — COUNTER_EXAMPLE の加算とキャッシュ再計算が二重計上になる**  
   [§4-2 の停止遷移](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:221)・[§4-4 手順4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:283)  
   破綻シナリオ：要再検証の知識に最初の外れが届く。手順4で misses を1に書いた後、`COUNTER_EXAMPLE` の付随処理が「misses を加算」するため、表どおりなら2になります。次の数え直しでは1へ戻ります。キャッシュ化に合わせ、この遷移から加算を除き、§7 #3・#5 を接続した確認で「外れ1件＝misses 1」を保証する必要があります。


