## Round 55 — 2026-11-23 — 反証(安全性)

モデル：Claude Opus 5.5（claude-opus-5-5）
対象：feat/practical-ab `git diff aee8d13~1..HEAD`（段 17a〜17e・17g・18a〜18c）。設計 §15（v30）・§11-11、台帳（2026-11-23 の行を優先）
実行：tests/server/routes-uke-notes・tests/chart/acts-routes・tests/server/routes-claim-reviews・tests/server/routes-facility-declaration・tests/server/erase（5 ファイル 27 件合格・2 件 skip）。high の候補がなかったので、ほかに実測はしていない

### 指摘

- [C-300] 種別: 実装 / 深刻度: mid
  - 指摘: 読むだけの GET 3 つ（`GET /api/uke/claims/[claimId]/check`、`GET /api/chart/[id]/claim`、月末の点検の取得）が `forgetDoubts` を呼び、クリニック全体で共有する `chart_act_aliases` の行を消している。版を選んだ試算の呼び出しも消す。消した行は戻らない
  - 根拠: src/server/app.ts の `forgetDoubts` と、それを呼ぶ `chartClaim`（revId があってもなくても呼ぶ）・`ukeCheck`・月末の点検の 3 か所。src/server/app/notes.ts の `forgetAliases`（DELETE）。src/server/app/notes.ts の `claimOfNote` では、試算の枝でも `torikawasure` を作っている。src/engine/revisions/r2027-06.ts は r2026 を引き継ぐので R18 を持つ。セッションの cookie は src/server/http.ts で `SameSite=Lax`
  - 破綻シナリオ: (1) 事務長が施設の種別をうっかり「在支診以外（3）」と申告する。直すまでの間に医療事務の誰かが取り込んだ請求の点検を開くと、R18 が機能強化型の区分の行に「同じ族の区分誤り」を付け、その書き方の前に選んだ対応がクリニック全体から消える。申告を直しても戻らないので、全員が次からまた候補を選び直す（L-95 の手間が増える）。(2) 算定プレビューで令和9年6月の版を選んだ試算を開くだけで、同じように消える。「試算は保存しない」（CLAUDE.md の固定条件）に反する。(3) GET なので、Lax の cookie はほかのサイトからのリンク（トップレベルの移動）でも付く。外から点検の URL を開かせるだけで消える（消える行の範囲は (1) と同じで、攻撃者が選べるわけではない）
  - 提案: 消すのをやめて、読むときに外す。`aliasOf` が、その書き方の対応が今の申告で R18 の区分誤りになるかを決まった規則で見て、なるなら初期値にしない。これで GET は何も書かない。書くのなら、POST /api/chart/acts の保存のとき（本人が確かめる操作）に寄せる。少なくとも試算の枝（revId がある呼び出し）では消さない

- [C-301] 種別: 実装 / 深刻度: low
  - 指摘: `recordBody.date` を正規表現でしか確かめていない。暦にない日（2026-10-32、2026-10-00）が通り、貼ったカルテとして残る
  - 根拠: src/server/schemas/chart.ts の `recordBody`（`/^\d{4}-\d{2}-\d{2}$/` だけ。src/server/schemas/facility.ts の `day` には暦の refine がある）。src/server/app/notes.ts の `saveRecord` は `startsWith(ym-)` しか見ない
  - 破綻シナリオ: 医療事務が「2026-10-31」のつもりで「2026-10-32」と打つ。保存は 200 で通り、確かめると `recordCounts` に入るので「貼った 1 人」と数える。G11 は 32 日の行為を UKE の 1〜31 日のどの日とも突き合わせられないので、その行為を「取り忘れ」として出す（請求にはその日の算定がある）。打ち間違いが、誤った取り忘れの指摘になる
  - 提案: facility の `day` と同じ refine を `recordBody.date` に足す

- [C-302] 種別: 実装 / 深刻度: low
  - 指摘: `POST /api/chart/acts`（`confirmActs`）が、カルテを書いた本人かどうかを照らさない。同じクリニックの医療事務・ベテランなら、だれでも他人の未確認のカルテを確かめて残せる
  - 根拠: src/server/app/notes.ts の `confirmActs`（`noteRow(id)` のあと `r.clerk_id` と `clerkId` を比べない）。消す操作（`deleteNote`）は本人かどうかを照らしている
  - 破綻シナリオ: A さんが訪問カルテを書き、確かめる前に席を外す。B さんが noteId を指定して `POST /api/chart/acts` を呼ぶ（UI の打ち間違い、または前の画面の再送）。A さんのカルテに B さんの選んだ事実・行為・院内／院外が残り、A さんの算定プレビュー（`confirmedNotes` は A さんの clerk_id で読む）が変わる。A さんがあとで確かめようとすると 409（「もう確かめてある」）になり、自分では直せない。既存の `confirmNote`（POST /api/chart/[id]）にも同じ穴があるが、v30 で入口が増え、確かめる中身が算定に効く行為まで広がった
  - 提案: 訪問カルテ（訪問診療・往診）は、書いた本人だけが確かめられるようにする。貼ったカルテ（記録）はチームで見る決まり（notes.ts のコメント）なので、照らすかどうかを kind で分ける

- [C-303] 種別: 設計 / 深刻度: low
  - 指摘: 取り込んだファイルを消しても、訪問カルテを消しても、`chart_act_aliases`（カルテの語から作った `written_norm`・選んだ人）が残る。§11-11 の「消す」の「残るもの」の一覧にこの表がない
  - 根拠: src/server/app/erase.ts（`claim_reviews` は足したが、`chart_act_aliases` は消さない）。tests/server/erase.test.ts は請求 id・患者 id が残るかだけを見るので、id を持たないこの表は検査に掛からない。src/db/migrate.ts の 15
  - 破綻シナリオ: 実在用のクリニックで、貼ったカルテから LLM が `written` に患者の固有の語を含む書き方（例：「〇〇様 胃瘻交換」。quote はカルテにあるので確かめを通る）を出し、本人が候補から選ぶ。ファイルを消しても、その語が対応の鍵として DB に残り、次の確かめの初期値にも出る。利用者は「消した」と思っている
  - 提案: §11-11 の「残るもの」に、前に選んだ対応（書き方 → コード。クリニックで共有）を書いて注意書きに載せる。あるいは、消す操作で、消したカルテからしか選ばれていない対応を消す。どちらにするかは設計で決める

- [C-304] 種別: 実装 / 深刻度: low
  - 指摘: 「この請求の点検を確かめた」を請求 id で数えている。同じ患者・同じ月のレセプトを中身を少し変えて取り込み直すと、別の請求として何度でも数えられ、レベル（Lv.5 からの院内の知識の「条件に当たる」）に届く
  - 根拠: src/server/app/claim-reviews.ts（主キーが (claim_id, clerk_id)）。src/uke/upload.ts（請求 id は取り込みの連番から作る）。src/server/app/uke.ts の `sameMonthKey` は知らせを出すだけで、取り込みは断らない。src/server/policy.ts（取り込みは WORK）。src/generic/local-pair.ts の `LOCAL_PAIR_MIN_LEVEL = 5`
  - 破綻シナリオ: 実在用のクリニックで、医療事務が 30 枚の UKE を 1 バイトずつ変えて 3 回取り込む（sha256 が変わるので別のファイルになる）。90 件の請求を「確かめた」で押すと件数は 90 になる。実際に点検したのは 30 患者分なので、レベルの線（L-123）を早く越え、院内の知識の押した事実（判定に効く）を残せるようになる
  - 提案: 数える鍵を「本人 × 患者 × 診療年月 × レセプト種別」（`sameMonthKey` と同じ）にする。同じ鍵の 2 回目は数えない

### 反論しなかった観点（確かめたこと）
- 権限表：新しいルート 10 本は、どれも policy.ts に載り、`external`・`patientData` を申告している。書かれた名前を受け取る `GET /api/chart/acts/candidates` は `patientData: true` なので同意が要る。申告を残すのは manager・veteran だけ。貼る入口は `external: "ai"`・`limit: "llm"`。既存の権限表のテストに掛かる
- AI に送るもの：`pasteRecord` が送るのはカルテの本文だけで、請求・患者マスタの構造化した値は足していない（§11-11 で、自由記述に書かれた氏名は外せないものとして注意書きに出す決まり）。行為をマスターに当てるのは手元だけで、AI に送らない
- テナント：DB はクリニックごと（getApp → openTenant）。新しい表（facility_declarations・claim_reviews・chart_act_aliases）はどれもクリニックの app.db に作る。マスターは公開データで共有。SQL はどれもプレースホルダで、`IN (...)` の組み立ても決まった表の名前か `?` の並びだけ
- 実在用でデモの値を使わないか：申告の種（becomeDemo）を入れるのは kind=demo の applyKind と、種の行がすでにある DB での 13 の run だけ。real は v28 の値を `migrated`・from_month 空（分からない）で移す。`facilityJsonOf` は real・未定では申告の項目と設定の項目を null から始める。`dispensingOf` は申告がなければ unknown で、G11 は薬を見ない
- FR-16：`reviewedOf`・`reviewClaim` は本人の分だけを返す。B の欄の「貼った n 人」は請求の数で、人ごとの件数ではない
- 監査ログ：POST はどれも対象を id か行の数だけで残し、値は残さない。エラーの文に、カルテの語・引用は入らない（`why` は決まった文）
- マイグレーション 14・15：表を足すのと列を足すだけで、前の行を書き換えない。13 の run は同じトランザクションの中
