委譲先: なし（このエージェントが直接実施）/ モデル: claude-opus-5-5

## Round 42 — 2026-11-22 — 反証(正しさ・安全性)

対象: `git diff feat/integration..fix/demo-real`（6 コミット。worktree fix-demo-real）
実測: scratchpad で `targets()`・`staleTenants()`・real の `openApp` を直接呼んだ（worktree は変えていない）。新しいテスト 5 本（38 件）は通る。

### 指摘

- [C-190] レンズ: 安全性 / 種別: 実装 / 深刻度: high / CONFIRMED
  - 指摘: `scripts/reset-demo.ts --retire-stale --yes` は種類を見ずに、データの版の印が違うクリニックを全部退避する。実在のデータで使うクリニックも退避される。
  - 破綻シナリオ: 合成データを入れ替えて `config/demo.json` の dataset を上げる → docs/revision-howto.md:53 の手順どおり、動いている環境で `--retire-stale --yes` を実行する → `staleTenants()`（src/server/dataset.ts:55）は tenants/ の下の `t…` を印だけで選ぶので、real のクリニックの置き場も `<id>.retired-…` に改名される → 次にその人がログインすると、`openTenant` が空の置き場を作り直す → 取り込んだ UKE・医師確認の記録・知識がすべて画面から消える（ファイルは退避先に残るが、戻すのは手作業）。実測: real で登録し、app.db に古い印を入れた置き場を作ると、`staleTenants` が返す一覧にその real のクリニックが入った。dfce038 で「demo のクリニックだけを消す」に直したのは `targets()` だけで、退避の経路には同じ絞り込みがない。real の置き場には作り物のデータの版がないので、印の食い違いを理由に退避する理由もない（`checkDataset` が real を開くたびに dataset.mismatch を残すのも同じ根）。
  - 提案: `--retire-stale` でも auth.db を開き、`tenantKind(id) === "demo"` のものだけを候補にする。real には dataset の印を付けない・比べない、でもよい。

- [C-191] レンズ: 安全性 / 種別: 実装 / 深刻度: mid / CONFIRMED
  - 指摘: `targets()` は dataDir に auth.db がなければ、全部を demo とみなす（`isDemo = auth ? … : true`）。一方、作業場所の置き場（`workspaceRoot()`。RESEMEN_WORKSPACES か OS の一時ディレクトリ）は dataDir に連動しない。このため、real のクリニックの作業場所も消す一覧に入る。
  - 破綻シナリオ: 公開版のホストで、サーバーは `RESEMEN_DATA=/mnt/disk` で動いている。運用者が RESEMEN_DATA を付けずに `npx tsx scripts/reset-demo.ts --yes` を実行する → dataDir は `<repo>/data` で、そこには auth.db がないので `isDemo` はいつも true → 共有の作業場所（同じ RESEMEN_WORKSPACES か、既定の tmpdir/resemen-workspaces）の下にある real のクリニック `t…` の作業場所が全部消える（メンターのセッション・メモが失われる）。実測: auth.db のない dataDir と、real のクリニックの作業場所を置いた ws を渡すと、`targets()` はその作業場所を返した。テスト「auth.db がない置き場所のクリニックは demo として扱う」は、この消し方を仕様として固定してしまっている。
  - 提案: 消す操作なので、判断できないときは消さない側に倒す。auth.db がないときは、tenants と作業場所の `t…` を消す一覧に入れない（または、実行を断って RESEMEN_DATA を求める）。作業場所は、dataDir の auth.db にあるクリニックの id だけを対象にする。

- [C-192] レンズ: 正しさ / 種別: 実装 / 深刻度: mid / CONFIRMED（静的読解）
  - 指摘: 実在のクリニックでも、会議の画面に「サンプル（K6・前の月の査定）を読む」が出る。`POST /api/notice {sample:true}` も種類を見ないので、作り物の査定通知と作り物の患者が実在のクリニックの画面に出る。
  - 破綻シナリオ: real のクリニックの事務長が会議の画面（app/meeting/page.tsx:123）でサンプルを押す → app/api/notice/route.ts:17 が `fixtures/notices/K6-…-satei.pdf` を読み、AI のサービスに送って読み取る（回数制限の llm を 1 回使う）→ 合成の患者氏名・保険者番号・項目が通知の結果として並ぶ。登録は `resolveNoticeItems` の絞り込みで「患者が見つからない」になって止まるので、知識には入らない。それでも、利用者が決めた「作り物のデータを見せない」が守られない。UKE の画面では real に断り書きを出して見本を分けたが、通知の見本は分けていない。
  - 提案: real ではサンプルのボタンを出さず、API でも `sample: true` を断る。UKE と同じくダウンロードだけにするなら、断り書きを付ける。

### 確かめて問題なしとした観点（参考）
- 作り物の種: `seedLocalRules` は real で空を返し、`openTenant` も demo のときだけ呼ぶ。`seed()`（制度層 R01〜R17）は作り物ではない。real の upload の請求 id は `U<連番>-<通し番号>` なので、`caseFileOf`・`chartFileOf`（K1〜K7）に当たらず、合成カルテ・症例の事実は混ざらない。実測: real の `openApp` で cases 0・UKE 一覧 0・drills 空・`seedLocalRules` は []。
- 時計: real の `now()` は `setting("now")` を読まない（実測 `2026-11-22T08:52:07+09:00`。OS の JST と一致）。`advanceClock` はハンドラで 403。`setting("now")` を直接読むのは clock.ts だけ。`period.clockStart` を読むのは DEFAULT_NOW だけ。
- catchUp: tickQueries・meetingReview はどちらも同期なので、try/catch と setSetting の順は保たれる。2 回目は null を返す（実測）。営業日の数え方（日本時間 0 時の区切り）と会議の曜日の判定はどちらも日の単位なので、その日の最初の操作で回せば取りこぼさない。失敗は instance.ts で握りつぶしてログに残し、`failedDay` で同じ日にもう一度回さない。
- 混ざる道: 招待で `kind` を渡すと 400 になり、招待を使わずに作るときは kind が必須。tenants 行は利用者の行と同じトランザクションで入る。kind の UPDATE はトリガーで止まる。ログインしない呼び出しは public のルートだけで、そのハンドラは getApp を呼ばない。ページ（page.tsx）も getApp を呼ばない。
- 権限: `{roles:["manager"], dev:true}` は本番では事務長だけに許す。solo の持ち主は役割を切り替えれば使える。GET の canAdvance は POST と同じ規則で計算している。
