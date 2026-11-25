批評役：Claude Opus 5.5（claude-opus-5-5）のサブエージェント 1 体（使い捨て。codex は使っていない）

## Round 32 — 2026-11-21 — 反証(安全性)

対象：.claude/worktrees/integration（feat/integration、HEAD 4a8af76）の 66f29e6..HEAD（design.md §12 v24 の実装）。
実測に使ったスクリプト：/private/tmp/claude-501/-Users-toshixa-Documents-iji-context/2b55f9e0-1fbd-45be-a64c-446b804ed7ab/scratchpad/r32-safety/g04direct.ts・g04bomb.ts（実データの masters.db を読み取り専用で開いた。リポジトリのファイルは変えていない）

### 指摘

- [S-9] 種別: 実装 / 深刻度: mid / **実測した**
  - 指摘: G04（包括）の指摘の数が「親の数 × 子の数」で増え、上限がない。細工した UKE 1 件で、点検の画面が 500 になり（`src/generic/index.ts:58` の `push(...found)` が RangeError）、その前に G04 が 2GB 近いメモリを使う。
  - 破綻シナリオ（誰が・何を・何が起きる）:
    1. 取り込みのできる利用者（`POST /api/uke/upload` は WORK のロール）が、診療年月 2026年10月の UKE を 1 件作る。SI の行を、補助マスターでグループ番号① A308031（包括単位 1＝1 日につき）の親 288 コードと、包括・被包括テーブルで同じグループの子のコードで埋め、全行を同じ算定日（1 日）・1 行 1 単位にする。行数・大きさ・算定回数の合計は UKE_LIMITS（5,000 行・1MB・20,000 回）の内側。版の表にないコードは対象外の単位（partial）になるだけで、読めないレセプトにはならない（読んだだけ。parseUke・mapClaim の経路）。
    2. だれかが `GET /api/uke/claims/[claimId]/check`（または `/trial`）を開く。`mastersPartOf`（`src/server/app/uke-check.ts:212`〜）が `evaluateGeneric` を呼び、`g04.run`（`src/generic/g04.ts:44-66`）が親子の組ごとに 1 件ずつ指摘を作る。
    3. 実測（実データの masters.db、G04 単体）：4,990 単位で **指摘 2,704,840 件・2.55 秒・RSS 1,995MB**。グループ A400003（1 手術につき）では 893,063 件・0.8 秒・775MB。evaluateGeneric 全体では、**700 単位で既に `RangeError: Maximum call stack size exceeded`（index.ts:58 の展開）**。400 単位では落ちずに 32,543 件・genericView を JSON にして 11MB（overlap を通す前）。
    4. 開くたびに計算し直す（保存しない）ので、同じレセプトを数回開く・複数の人が開くと、そのたびに 2GB 規模の確保が重なり、Next のプロセスがメモリ不足で落ち得る（重ねた実測はしていない）。正しいレセプトでは起きない（親子の組は数十まで）。
  - 段 14 の報告の G09（薬 4,900 品目で 1.1 秒・3,094 件）について：G09 は、コードごとに傷病名の引き方を 50 件で表の側に切り替える（`g09.ts:99-104`）ので、手間はコードの数に比例し、指摘はコードごと 1 件。これは許容できる側と判断した（読んだだけ）。上限が要るのは、組で増える G04（と、表の行数 78,808 までは組で増える G05）のほう。
  - 提案: 点検ごと（か全体）の指摘の数に上限を置き、超えたら「ほか N 件」と数だけを返す（例：点検ごとに 200 件）。あわせて index.ts:58 の `push(...)` を、展開でない足し方にする。G04 は、同じ子の指摘を画面でまとめているので、計算の側で子ごとにまとめても意味は変わらない。

- [S-10] 種別: 実装 / 深刻度: low / **読んだだけ**
  - 指摘: zip を展開した大きさの上限（`MAX_UNZIPPED_BYTES`）は、`unzip -l` の目次の申告値だけで見ていて、`unzip -p` が実際に書き出すバイト数には上限がない（`scripts/fetch-masters.ts:104-105, 117`）。
  - 破綻シナリオ: 許可したホスト（config/masters.json の厚労省・審査支払機関などのホスト。https・証明書の検証つき・リダイレクト拒否）が、目次の大きさを小さく偽った zip を返した場合、`--yes` を付けて実行した事務長の手元で、100MB の zip が deflate の上限の比率（約 1,000 倍）まで展開され、`<データ置き場>/masters/fetch-*/` の書き込みでディスクが埋まる。終わったあと `rmSync` で消えるが、途中で同じディスクにある app.db の書き込みが失敗し得る。前提が「公開元のサーバーが乗っ取られる」なので low。
  - 提案: `spawnSync` の標準出力をファイルの fd ではなくパイプで受け、書いたバイト数を数えて MAX_UNZIPPED_BYTES を超えたら止める（または、ファイルごとの上限を config の想定の数倍にして `fstat` で見る）。

### 確認して問題なしとした観点（指摘にしなかったもの）

1. **取り込みの接続先**（読んだだけ）：`get` は https・config のホストだけ・URL の利用者情報なしを確かめ、名前解決の結果を全部内部アドレスの検査に通してから 1 つに固定して接続する（`pinnedLookup`）。200 以外は従わずに捨てる（リダイレクトも）。大きさはストリームで数えて上限で切る。`--yes` なしでは公開ページの HTML（2MB 上限）しか読まない。HTML から拾った href は `new URL(m[1], page)` で別ホストに解決されても `get` の許可リストで止まる。zip の中の名前は `safeName` で絶対パス・`..` を断り、ファイル名はこちらで決め（`<n>.out` → 置き場ではサニタイズした名前）、置き場に既にあるものは上書きしない。
2. **masters.db の作り方**（読んだだけ）：CSV はストリームで読み、ファイル 600MB・500 万行・1 行 2 万文字の上限があり、Shift_JIS の fatal 復号、項目数の一致を行ごとに確かめる。行をメモリに貯めない。SQL の識別子は layout.ts の定数だけで、値は全部プレースホルダー。作りかけは `masters.db.building` に書き、検査が全部通ってから `renameSync` で置き換える（同じフォルダなので原子的）。アプリは `.building` を開かない。raw の走査は lstat でシンボリックリンクをたどらない。
3. **アプリが masters.db を読む部分**（読んだだけ）：`openMasters` は `readonly: true, fileMustExist: true`。パスは環境変数とデータ置き場から決まり、リクエストの値は入らない。表名の補間（`one`・`nameOf`・g09 の `listed`／`matcher`）は型で縛った定数だけ。
4. **新しい API と権限表**（読んだだけ）：`GET /api/masters` は manager だけ、external・patientData とも none/false で、返すのは公開データのファイル名・件数・取り込み日時・点検の準備・取り込まなかった理由（定型文と行番号。行の中身は MasterFormatError に入れない）。`confirm` に足した `generic` と、check・trial に足した `names`・`diseases`・`stopped`・`generic` は、もともと患者名を返している画面・ロールの範囲の中で、足した中身はマスターの名称とコード（コメントの自由記載は `names.comments` に入らない。コメントマスターの定型文だけ）。
5. **指摘の文・ログ**（読んだだけ）：G01〜G09 の params はコード・マスターの名称・点数・日付・表の行の参照だけで、患者の氏名・番号・生年月日・コメントの文字データは入らない（G03 は生年月日から年齢を判定するが、文には表の年齢の範囲だけを出す）。src/generic・src/masters/db.ts・新しいサーバーのコードに console 出力・監査ログの書き込みは足されていない。
6. **AI に送る文脈**（読んだだけ）：`claimForAi`（src/llm/outbound.ts:69）は claimId・yearMonth・history の許可リストで写すので、段 10a〜14 で UkeItem・UkeUnit に足した shikibetsu・unitCode・unitPrice や、ClaimContext に足した outside は入らない。
