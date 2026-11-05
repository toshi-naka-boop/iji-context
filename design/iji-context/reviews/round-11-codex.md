critic: codex/gpt-6.1-sol xhigh（反証 round-11。ID は台帳で X-42〜X-46 として採番）

5件です。既存61ケースと追加シナリオを、FS・SQLiteをメモリ上に置いた検証ハーネスで確認しました。通常のVitestは未実行、実ファイルの変更はありません。

1. **【設計／high】回答の復旧が、その後の外れを永久に判定対象から外す**

   **入力・破綻：** 要再検証の知識に4/1に回答1を記録し、反映前に停止。4/2の提出に査定が届き、4/7に整理すると、拾い直しが `status_since=4/7` で承認済みに戻す。4/2の提出は時刻条件に落ち、翌週以降も降格できない。同じ回答を4/1に正常反映した場合は、4/7に要再検証へ下がる。
   
   **該当行：** [review.ts:163](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:163)、[207行](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:207)、[machine.ts:157](/Users/toshixa/Documents/iji-context/src/lifecycle/machine.ts:157)。設計 §4-4 手順3の「拾い直しでも `status_since=now`」が原因。
   
   **最小修正案：** 回答の遷移基準時刻を `answeredAt` とする。「1整理で1段」は別の処理済み印で守り、回答後の提出を次回以降も判定できるようにする。

2. **【実装／high】正常な見出しから作る修正版候補が、週次整理全体を止める**

   **入力・破綻：** `summary="a".repeat(1024)` の知識を要再検証にし、回答2を送る。元の知識は停止になるが、候補の見出しに「（修正の候補）」を追加して1024文字を超え、生成に失敗する。回答は `applied=false` のまま残り、以後すべての整理が手順0で同じ例外により中断する。
   
   **該当行：** [review.ts:479](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:479)、[518行](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:518)、[store.ts:87](/Users/toshixa/Documents/iji-context/src/lifecycle/store.ts:87)。
   
   **最小修正案：** 接尾辞の長さを予約して派生見出しを1024文字以内に収め、候補入力の検証を停止遷移より前に済ませる。

3. **【実装／mid】再審査「復活」が、承認済み知識を生成せず保管だけを確定する**

   **入力・破綻：** 査定由来の地域知識を `slug="a".repeat(40)` で作り、申出後に `REEXAM_RESULT{復活}` を適用する。元の名前は上限内だが、派生名の `-reexam-allowed` 追加で64文字を超える。元知識は既に保管されており、派生知識は0件。再送しても保管からの遷移として拒否される。
   
   **該当行：** [store.ts:172](/Users/toshixa/Documents/iji-context/src/lifecycle/store.ts:172)、[219行](/Users/toshixa/Documents/iji-context/src/lifecycle/store.ts:219)、[86行](/Users/toshixa/Documents/iji-context/src/lifecycle/store.ts:86)。
   
   **最小修正案：** 派生slugを上限内の決定的なIDにし、生成入力を保管確定前に検証する。

4. **【実装／mid】拾い直した「取り忘れだった」の通知が消える**

   **入力・破綻：** `ignored` の回答1を記録し、反映前に停止して次の整理で復旧する。`USED` と `applied=true` は保存されるが、`reflect()` が返す `notify` は捨てられる。整理の戻り値にも通知はなく、回答再送も `duplicate` となるため、新人のメンターへ通知を渡せない。
   
   **該当行：** [review.ts:163](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:163)、[524行](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:524)、[534行](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:534)。
   
   **最小修正案：** 通知を `itemId` 付きの未配信データとして保存し、直接回答と拾い直しの共通経路から取得・配送できるようにする。

5. **【設計／mid】廃棄理由が覆っても、訂正前の問いへの回答を受理する**

   **入力・破綻：** 外れ2件で停止し、`overturned=false` の廃棄提案を届ける。その後、両提出が通過に訂正され、次の整理で `hits=2・misses=0・overturned=true` になっても項目IDは同じ。訂正前の問いに対する「廃棄する」が届くと、そのまま保管される。
   
   **該当行：** [design.md:321](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:321)、[review.ts:308](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:308)、[505行](/Users/toshixa/Documents/iji-context/src/lifecycle/review.ts:505)。照合に判断根拠の版が含まれない。
   
   **最小修正案：** snapshotに根拠のハッシュ等を加え、結果訂正で理由が変わった場合は旧項目への回答を `stale` にする。


