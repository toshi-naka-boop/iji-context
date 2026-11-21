# 同梱の合成データでしか動かない箇所（サーバー：src/server/** と app/api/**）

調べた日：2026-11-22。対象：`.claude/worktrees/integration`（feat/integration、83d1442）。読むだけで、コードは変えていない。
行番号はこの時点のもの。「推測」と書いたもの以外は、呼び出し元までコードを追って確かめた。

## 前提（調べて分かった、全体に効くこと）

- 請求 id：同梱の見本は `K1-2026-10` の形、アップロードした UKE は `U<取り込みの連番>-<通し番号>`（src/uke/upload.ts）。`caseFileOf`・`chartFileOf`（src/server/app/case-files.ts）は頭の `K1`〜`K7` だけを表で引くので、`U…` は必ず null になる。
- 見本の UKE 2 本（fixtures/uke/*.UKE）は、どのクリニック（tenant）でも `named()`（src/server/app/uke.ts:64）の先頭に必ず入る。`cases()` はそれを全部請求にする。
- 時計：`now()` は app_settings の `now`、なければ `config/demo.json` の `clockStart`（2026-10-13T09:00+09:00）。進めるのは `POST /api/clock` だけで、権限表で `dev`＝本番では 404（src/server/policy.ts:141、src/server/http.ts:171）。**公開版では、どのクリニックでも時計が 2026-10-13 に止まったまま**。
- ORCA・FHIR のコネクタ（src/connect/）は、src/server と app/api のどこからも呼ばれていない（呼ぶのは scripts/fetch-masters.ts・scripts/gen-connect.ts だけ）。

## 表 1：実在のデータで問題になる箇所

重さ：高＝実在の運用で誤る・黙る／中＝使えない機能がある／低＝表示だけ

| # | 場所（file:line） | 何をしているか | 実在のデータで何が起きるか | 重さ | 直し方の案（1 行） |
|---|---|---|---|---|---|
| 1 | src/server/app/knowledge.ts:64（resolveNoticeItems）→ src/notice/notice.ts:99・107・117 | 返戻・査定の通知の項目を、患者は fixtures/uke/patients.json の氏名＋保険者番号で、項目は版の区分の名称の完全一致で、都道府県は `cases()` の請求から照らす | 取り込んだレセプトの患者は patients.json にいないので、全項目が「患者が見つからない」になり候補が作れない（画面には problems が出る）。名称が少しでも違う項目も当たらない（既知の 1 件） | 高 | 患者は `ukeReceipts()`（＋患者マスタ）から引き、項目は基本マスターのコード・名称で照らす |
| 2 | src/server/app/clock.ts:14-16・src/server/policy.ts:141・src/server/http.ts:171 | 時計の値はデモの時計だけ。本番では進める入口が 404 | 公開版では「今日」が 2026-10-13 のまま。下の 3〜7 がすべてこの日付で判定・記録される | 高 | 本番（または実データのクリニック）では実時刻を返し、デモの時計は見本の請求の画面だけに使う |
| 3 | src/server/app/clock.ts:23-30（advanceClock だけが tickQueries と会議の整理を回す） | 医師確認のリマインド（翌営業日）・保留（3 営業日）と、週 1 回の会議の整理は、時計を進めたときにしか動かない | 公開版では医師確認がいつまでも「未回答」のまま、リマインドも保留も付かない。会議の整理は `POST /api/meeting`（コメントは「デモ」）で手で回さない限り動かない。何も表示されず黙る | 高 | 実時刻で定期に回す（起動時・一覧を開いたとき・スケジューラ）か、本番で手動の入口をはっきり置く |
| 4 | src/server/app/patients.ts:224（checked の `today: now()`）→ src/patient/checks.ts:214・228・235 | 患者情報チェック P06（保険の期限）・P07（要介護認定の期限・期限間近）・P08（生年月日が未来）の「今日」がデモの時計 | 実在の加入情報で、期限が 2026-10-13 より後なら、実際には切れていても指摘が出ない（逆に古いデモ日付基準で判定）。黙って誤る | 高 | today は実時刻（または請求の診療年月の末日など、規則で決めた基準日）にする |
| 5 | src/server/app/cases.ts:87（applyPatientFacts の `now()`）・src/server/app/patients.ts:179（isExpired） | 患者ごとに確かめた事実（要介護度など）の期限切れを、デモの時計で判定する | 要介護度の認定が実際には切れていても「有効」として R03（包括的支援加算）などの判定に使われる。黙って誤る | 高 | 期限の判定は、請求の診療日（算定日）か実時刻で行う |
| 6 | src/server/app/patients.ts:187（validatePatientFact の `now()`）→ src/patient/facts.ts:29 | 要介護度の有効期間の終わりが「今日より前」なら断る。今日はデモの時計 | 2026-10-13 より後の日付なら、実際には切れた期限でも通る。2026-10-13 より前に切れた（過去の月の請求の）期限は入れられない | 中 | 4・5 と同じ基準日にそろえる |
| 7 | src/server/app/knowledge.ts:149・181・198（jstYearMonth(now())、stale） | 知識の一覧・公的文書の確認は「今の年月」の版で突き合わせ、180 日使われていないかもデモの時計で数える | 公開版ではずっと 2026-10 の版で突き合わせる。180 日のトリガー（stale 表示と会議の要再検証）は時が進まないので実在の運用では出ない。黙る | 中 | 2 と同じく実時刻を使う |
| 8 | src/server/app/patients.ts:87・128・194・251、claim-facts.ts:103、doctor.ts:20-21・34、peer.ts:27・33・43、doctor-facts.ts:85、notes.ts:44・140 ほか（`now()` を記録の日時に使う） | 確かめた日時・回答日時・作成日時を、デモの時計で残す | 公開版では、全部の記録の日時が 2026-10-13T09:00 になる。履歴の「いつ確かめたか」が読めない（最新の 1 件は id で選ぶので、値の取り違えはない） | 中 | 記録の日時は実時刻（監査ログの `at` と同じ `new Date()`）にし、デモの時計は別欄に持つ |
| 9 | src/server/app/doctor.ts:55-58（crosscheckOf）← notes.ts:224-228（chartOf）← case-files.ts:35 | 病名と処方の照合（F4）は、合成カルテ（fixtures/charts/）と本人が書いた訪問カルテだけを相手にする | 取り込んだレセプトは合成カルテがなく、訪問カルテも書けない（#11）ので、chart が null → `mismatches: []` を返す。照合していないのに「不一致なし」と同じ形。メンターに渡す照合（instance.ts:293-300）も空。黙る | 高 | chart が null のときは「照合の元の記録がないので照合していません」を返す形を分け、画面とメンターに渡す |
| 10 | src/server/app/context.ts:60 → src/server/app/facility.ts:19 → config/facility.json | 施設の設定は config の既定値に、事務長が残した値を重ねる。既定値は `dxTier:"1"`・`baseUp:"通常"`・`priceResponse:true`・`note16Met:true`（三値のうち「分かっている」側） | 事務長が設定しないままの実在のクリニックでも、これらを「分かっている値」として判定する。届出のない加算を通す・指摘しないことがある。黙って誤る | 高 | 実データのクリニックでは既定を null（分からない）にし、未設定の項目を画面に出す |
| 11 | src/server/app/facility.ts:5（FACT_KEYS）・config/facility.json | 画面で変えられるのは三値の 6 項目だけ。`zaishishin`・`kyokagata`・`hasBeds`・`prefecture` は config の固定値（在支診・機能強化型以外・病床なし・東京都） | 機能強化型・病床ありの在支診や東京都以外のクリニックが実在の UKE を入れると、施設の区分を取り違えたまま判定する。黙って誤る（CLAUDE.md の固定条件の範囲なら正しい） | 高 | 固定条件の外のクリニックを受けるなら、この 4 項目も tenant ごとに持つ。受けないなら取り込み時に断りを出す（要判断） |
| 12 | src/server/instance.ts:109 → src/server/app/knowledge.ts:75-86 → src/lifecycle/seed-local.ts:22-49 | 新しいクリニックを開くたびに、院内ルールの種 12 件（承認済み 9 件ほか。中身は伏せた作り物、日付は何年も前）を入れる | 実在のクリニックの知識に、作り物の院内ルールが「承認済み」で入る。区分だけで当たるので、実在の請求のローカルルール欄に出て、提出のたびに当たり、会議の要再検証の議題にもなる。利用者には本物の院内ルールと見分けにくい | 高 | 種はデモ用の tenant（または見本の請求）だけに入れる。実データの tenant では入れない |
| 13 | src/server/app/knowledge.ts:79-85（SAMPLE_NOTICE_BASE＝fixtures/notices/K6-…-satei） | 同じく、合成の K6 の査定通知から地域ルールの候補（未検証）を 1 件入れる | 作り物の患者の査定から作った「東京都・審査支払機関・区分」の地域ルールが、実在の請求のローカルルール欄に未検証として当たる。ベテランが承認すればメンターも使う | 中 | 13 も 12 と同じく、デモ用の tenant だけに入れる |
| 14 | src/server/app/uke.ts:64-67（named）→ cases.ts:96（cases）→ doctor-facts.ts:62-71・notes.ts:183・207・app/api/cases/route.ts | 見本の UKE 2 本を、どのクリニックでも請求の一覧に必ず入れる | 実在のクリニックで、医師に確かめてほしい項目（GET /api/doctor/facts）に作り物の患者 K1〜K7 の項目が混ざる。GET /api/cases、カルテを書く患者、訪問の一覧も同じ。患者マスタにも見本の患者が入る（cases.ts:83 の ingest） | 中 | 見本は「取り込んだ」と記録した利用者・デモ用の tenant だけに出す（importedClaims と同じ絞り込みを掛ける） |
| 15 | src/server/app/notes.ts:38（saveNote） | アップロードした UKE のレセプトには訪問カルテを書かせない（文言で断る） | 実在の請求では、訪問カルテ → 事実の確定 → 算定プレビュー（FR-94〜102）→ 摘要欄の値の入力（FR-176）が全部使えない | 中 | カルテ側の記録がない請求でも、本人が書いたカルテから出来事を作れるようにする（設計の判断が要る） |
| 16 | src/server/app/notes.ts:183-204（patients）・207-222（visits）← src/visit/as-of.ts:16-21（visitDays は events だけを見る） | カルテを書く患者・訪問の一覧は、症例の出来事（events）にある訪問の日だけから作る | 取り込んだレセプトは events が空なので、UKE の行に訪問診療の算定日があっても一覧に出ない。断りなく空（見本だけが並ぶ） | 中 | 出来事がない請求は「カルテ側の記録がないので出していません」を返すか、UKE の算定日から訪問の日を作る |
| 17 | src/server/app/revision.ts:20・25（compareOf） | 改定の比較は recordsKnown が真の請求（＝同梱の症例）だけを並べ、ほかは文言で断る | 実在の請求では改定の比較が使えない（一覧に出ない。直接指定すれば断りが出る） | 中 | 取り込んだレセプトの比較は、試算（ukeTrial）の 2 版並べで代える |
| 18 | src/server/app/patients.ts:231（checkConnectorPatient）・src/connect/ | 連携のコネクタから読んだ患者を患者マスタに入れてチェックする関数はあるが、どの API ルートからも呼ばれていない。ORCA・FHIR のコネクタも src/server から使われていない | 実在の ORCA・FHIR からは、画面からは何も取り込めない（RESEMEN_CONNECTORS を設定しても入口がない） | 中 | コネクタの読み込み → 患者マスタ・請求への取り込みのルートを足す（権限表に行を足してから） |
| 19 | src/server/instance.ts:110・233-249（askVeteran は VETERAN_CLERK＝vet1）・src/server/app/clerks.ts:7 | どのクリニックにも「ベテラン」という名前のデモの医療事務 vet1 を作り、ベテランのメンターは常に vet1 の作業場所・セッションで動く | 実在のベテラン（招待で入った利用者）がいても、メンター同士の問いは vet1 の会話に積もる。答えは peer_questions に入るので運用は回るが、誰のメンターかは名前と合わない | 低 | ベテランのメンターをクリニックごとの共有の役として名付け直すか、実在のベテランに結び付ける |
| 20 | app/api/master/route.ts:271 | 区分の一覧は、yearMonth がなければ config/demo.json の基準月の版を返す | 呼ぶ側が年月を付けないと、実在の請求の月と違う版の区分・点数が出る（推測：画面が yearMonth を付けているかは担当外で未確認） | 低 | yearMonth を必須にする |
| 21 | src/server/app/questions.ts:70 | 選択モードは、アップロードしたレセプトでは文言で断る | 実在の請求では選択モードが使えない（練習の機能なので影響は小さい） | 低 | このままでよい（文言あり） |

### 重さごとの件数

- 高：9 件（#1・#2・#3・#4・#5・#9・#10・#11・#12。既知の #1 を除くと新規 8 件）
- 中：9 件（#6・#7・#8・#13・#14・#15・#16・#17・#18）
- 低：3 件（#19・#20・#21）

## 表 2：デモ専用で問題ないと判断したもの

| 場所（file:line） | 何をしているか | 問題ないとした理由 |
|---|---|---|
| src/server/app/case-files.ts:6-38 | 請求 id の頭（K1〜K7）で同梱の症例・合成カルテのファイルを引く | 取り込んだレセプトの id は `U…` なので必ず null になり、見本の id と取り違えない。null のときは「事実はすべて不明・記録なし」に倒れる（下の行）。null を黙って使う先は表 1 の #9・#16 に挙げた |
| src/server/app/cases.ts:21-60（UNKNOWN_FACTS・caseBaseOf） | 症例のないレセプトは、事実をすべて「不明」、出来事なし、recordsKnown 偽にする | 推測で埋めず、エンジンが情報不足として出す（design.md §11-6）。年齢・保険種別・負担割合は患者マスタから上書きする。黙って空にはしていない |
| src/server/app/uke-check.ts:122-153 | 取り込んだレセプトを UKE のとおりに点検する | 見本でも出来事を使わない（131 行）。実在のレセプトでも同じ道で動く。版のない月は試算に回すと返す |
| src/server/app/uke.ts:17・137-141（sampleUke）・app/api/uke/sample/route.ts | 見本の UKE のダウンロード | 見本を配るだけの機能。表 1 #14 の「一覧に混ざる」は別に挙げた |
| src/server/app/uke.ts:158・174 | 見本と同じ内容のファイルを上げたら、見本として取り込む | 内容が同じなら見本そのもの。実在のファイルが見本と一致することはない |
| app/api/notice/route.ts:374-381（b.sample） | 見本の査定通知 PDF を読む選択肢 | 利用者が「見本」を選んだときだけ。実在の PDF は pdfBase64 の道で読む（対応づけの問題は表 1 #1） |
| src/server/app/questions.ts:59-65・153-184、src/server/app/question-case.ts:24-39 | 練習問題（明細・医師確認）は同梱の症例の請求で始める | 練習問題は作り物の症例のための機能。見本の UKE はどの tenant にも必ずあるので動く |
| app/api/mentor-check/route.ts:316 | fixtures/cases/K2.json でメンターの動作を確かめる | 権限表で dev（本番では 404）。開発時の確認だけ |
| app/api/eval/route.ts・app/api/sdk-check/route.ts | 評価・SDK の動作確認 | dev（本番では 404） |
| src/server/instance.ts:57・63（OWNER_CLERK＝new1） | 1 人で始めたクリニックの持ち主は new1 の行を使う | 名前は本人が決めた名前で上書きされ（ensureClerk・setClerkName）、tenant ごとに分かれている。デモの利用者を前提にした判定はない |
| src/server/instance.ts:122-141（DEMO_CLERKS の全員） | ログインなしの呼び出しで、data/resemen.db に新人・ベテランを作る | ログインなしで呼べるのは public の 3 ルートだけで、どれも getApp() の請求を使わない。テスト・スクリプト用 |
| src/server/dataset.ts | 置き場にデータの版の印（config/demo.json の dataset）を残す | 印が違っても止めず、警告を記録するだけ。実在のデータの扱いは変えない |
| src/server/app/notes.ts:41 | 訪問カルテの日付がデモの時計で、診療月の外なら断る | 書けるのは見本の請求だけ（#15）なので、いまは見本のデモの中で閉じている。#15 を直すときは #2 と一緒に直す |
| src/server/app/meeting.ts:14・app/api/meeting/route.ts:295 | 会議の整理をすぐ回す入口（コメントは「デモ」） | ベテランだけが呼べ、本番でも動く。公開版で会議を回せる唯一の入口になっている点は表 1 #3 に挙げた |

## 担当の外で気づいたこと（一行メモ）

- src/visit/as-of.ts:16：訪問の日は events だけから作り、UKE の算定日を見ない（#16 の元）。
- src/notice/notice.ts:107：区分の名称の完全一致（#1 の元）。基本マスターの名称・コードを使う道がない。
- src/lifecycle/seed-local.ts:52：種の区分の名前は基準月（config/demo.json）の版から取る。
- src/connect/index.ts:22：既定で有効なのはフィクスチャのコネクタだけ（src/server からはどれも使われていない）。
- config/facility.json：三値の既定値が「分かっている値」になっている（#10）。
