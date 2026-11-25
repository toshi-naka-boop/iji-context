critic: codex/gpt-6.1-sol xhigh

**5件あります。high は2件です。**

初回の「種類不明のデータ削除」「realの退避」「見本UKE・通知の新規利用」「一時失敗後の再試行」は修正されています。ただし、以下が残ります。

1. **[実装 / high] 旧版で移行済みのクリニックはdemo固定のまま**
   
   [migrate.ts:150](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/src/db/migrate.ts:150)
   
   既存のマイグレーション5を書き換えています。`2e03207`を起動済みのDBは適用済みとして処理を飛ばすため、自動設定された`demo`と旧トリガーが残り、未選択になりません。実在データを持つ既存クリニックでも選択画面が出ず、合成データ・デモ時計が有効になり、`reset-demo --yes`の削除対象にも残ります。旧版→新版の移行で再現しました。

2. **[実装 / high] 会議回答の復旧処理が、除外した合成知識を書き換える**
   
   [review.ts:216](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/src/lifecycle/review.ts:216)
   
   回答済み・未反映の項目は、`excluded`を確認せず復旧します。デモ時のK6知識への回答2が、回答保存後の障害で未反映になった状態でrealを選ぶと、次の整理で合成知識が変更されます。**「要再検証／history 3件」→「停止／4件」**を再現しました。さらに修正候補が合成の印なしで生成され、承認すればSkillにも入ります。

3. **[実装 / medium] 見本請求の査定結果がrealの集計・会議に残る**
   
   [meeting.ts:17](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/src/server/app/meeting.ts:17)
   
   非表示判定は項目直下の`submissionId`だけを見ますが、`miss`項目ではここが`null`で、提出IDは`reason.misses`に入ります。K1の提出・査定結果を持つクリニックがrealを選ぶと、制度知識の`misses`が1と集計され、その見本提出を根拠とする会議項目も表示されました。

4. **[実装 / medium] 未選択中でも招待を受諾でき、誰も種類を選べなくなる**
   
   [http.ts:189](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/src/server/http.ts:189)
   
   公開の登録ルートはゲート対象外で、招待先の種類も確認しません。既存の一人クリニックの持ち主が事務ロールで、未使用の事務向け招待がある場合、未選択中に受諾すると二人になります。持ち主は「一人」の選択権を失い、事務長もおらず、役割変更も拒否されます。両者が選択不能になることを再現しました。

5. **[実装 / medium] 未来まで進めたデモ会議日時が、realの自動整理を止める**
   
   [clock.ts:39](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/src/server/app/clock.ts:39)
   
   デモで2027年6月まで進めた既存クリニックが、実際の日付2026年11月にrealを選ぶと、未来の`reviews.ran_at`が前回日時として使われます。翌週も会議整理が実行されず、`caught_up_at`だけ更新されました。未来の会議日時を越えるまで、自動整理・トリガー評価が数か月遅れます。

インメモリSQLite・仮想FS・直接関数呼び出しで再現しました。通常のVitestは未実行、実ファイルは変更していません。
