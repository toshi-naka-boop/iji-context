critic: codex/gpt-6.1-sol xhigh

5件です。**high は4件**で、うち1件は既存データに関する前提に依存します。

1. **[実装 / high] 種類を確認できない実在データまで削除する**
   [reset-demo.ts:40](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/scripts/reset-demo.ts:40)
   
   `auth.db` がない場合も、tenant の種類の行がない場合も demo 扱いになります。例えば、real の `tenants/` だけを復元した状態で `reset-demo --yes` を実行すると、実在の UKE・患者DBを含むディレクトリ全体が削除対象になります。「不明」を「削除してよい」に変換しています。

2. **[前提 / high] 既存テナントを無条件で demo に永久固定する**
   [migrate.ts:152](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/src/db/migrate.ts:152)
   
   更新前から実在 UKE を保存しているテナントが存在すると、移行で demo にされ、種類変更もトリガーで禁止されます。その後は合成症例・種ルールが表示／投入され、時計もデモ時計になり、通常の `reset-demo` の削除対象にもなります。**既存テナントに実在データがないことは未確認**です。

3. **[設計 / high] real に見本 UKE を配布し、実在請求として保存する**
   [uke/page.tsx:96](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/app/uke/page.tsx:96)、[uke.ts:162](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/src/server/app/uke.ts:162)
   
   real の画面に見本のダウンロードリンクを出し、そのファイルのアップロードも許可しています。実際に同梱 `kokuhoren.UKE` が `uploaded: true / imported: true`、請求ID `U1-1`〜`U1-6` として受理されました。月末点検を開けば合成患者も患者マスタへ入り、「合成データを取得・表示しない」という要件を破ります。

4. **[実装 / high] `--retire-stale` は real の稼働データも退避して初期化する**
   [reset-demo.ts:63](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/scripts/reset-demo.ts:63)
   
   この分岐は `targets()` の種類判定を通りません。デモの dataset 印を更新して `reset-demo --retire-stale --yes` を実行すると、古い印を持つ real の保存先も改名されます。サーバー再起動後は空の保存先が作られ、実在の請求・患者・知識が画面から消えます。元データは退避先に残りますが、real の運用がリセットされます。

5. **[実装 / medium] 一時的な失敗で当日の日付変更処理を打ち切る**
   [clock.ts:66](/Users/toshixa/Documents/iji-context/.claude/worktrees/fix-demo-real/src/server/app/clock.ts:66)
   
   最初の処理で `SQLITE_BUSY` などが起きると `failedDay` が設定され、障害解消後も同日のリクエストでは再試行しません。直接呼び出しでも、復旧後の呼び出しが `null`、試行回数が1回のままになることを確認しました。リマインド・保留・会議処理が、翌日かアプリ実体の作り直しまで欠落します。

通常の Vitest は未実行です。見本取得・取込、移行、削除対象判定、失敗後の再試行を、メモリDB・仮想FS・直接関数呼び出しで確認しました。実ファイルは変更していません。
