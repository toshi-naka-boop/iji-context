委譲先: claude（Claude Code サブエージェント）/ モデル: claude-opus-5-5

## Round 21 — 2026-11-18 — 反証(過剰実装と読みやすさ)

対象: feat/integration（`git diff origin/main...HEAD`、362 ファイル）。静的に読んだ。O-1 は high の候補なので、tests/server/authz.test.ts と proxy.ts で白黒をつけた（招待なしは 403、ログイン画面と /api/auth/ 以外は未ログインで入れない）。
台帳で扱いが決まっている点は再提起しない。たとえば `Facility.notifications`・`hasBeds`・`visitsComplete` は design.md §6-1 と 417 行に「どこからも読まれていない。消さずに指摘に留める」とあり、C-80 も処理済みとして扱われている。

### 指摘

- [O-1] 種別: 実装（文書）/ 深刻度: high
  - 指摘: 招待制にしたのに、最初の 1 人を作る手順がどこにも書かれていない。docs/deploy-gcp.md には「誰でも登録できる」という古い記述が残っている。
  - 破綻シナリオ: README の「手元で動かす」（README.md:240-250。`npm install` → `.env.local` → `npm run dev`）や docs/deploy-gcp.md:89（「ログイン画面の『はじめて使う』で登録できます」）のとおりに進めると、招待コードを持っていないので `POST /api/auth/register` が 403「登録には招待コードが必要です」で止まる（app/api/auth/register/route.ts:19、tests/server/authz.test.ts:93-96 で確認）。招待を作るのは manager か solo の持ち主だけで、そのどちらもまだいない。CLI もシードも用意されていない（scripts/ に招待を作るものはない。reset-demo は auth.db を残すだけ）。抜け道は `RESEMEN_OPEN_SIGNUP=1` だけだが、README・deploy-gcp.md のどちらにも出てこず、deploy/start.sh も環境変数として渡していない。さらに deploy-gcp.md:103 の「登録は誰でもできる」と :104 の「忘れたら別のログイン ID で登録し直す」は、招待制では成り立たない。
  - 提案: README と deploy-gcp.md に「`RESEMEN_OPEN_SIGNUP=1` で最初の 1 人を登録 → 設定から招待を作る → 外して起動し直す」を書く。:103-104 は招待制に合わせて書き直す。

- [O-2] 種別: 実装 / 深刻度: mid
  - 指摘: FR-111「判定の対象外 n 件」の経路が型の段階で途切れている。コネクタは `UnmappedLine {claimId, code, dates}` を返し、エンジンは `ClaimContext.excluded {code, count}` を受け取る。2 つをつなぐ変換も、`excluded` を作るコードもない。
  - 破綻シナリオ: `excluded` を作る箇所が本番コードに 0 件で、`excludedCount` を表示する画面も 0 件（grep で確認）。`evaluate` の `excludedCount = ctx.excluded.length`（src/engine/index.ts:33）は件数ではなく要素数で、`count` の欄はどこからも読まれない。唯一のテスト（tests/engine/revisions.test.ts:85）は `count: 1` の 1 件なので、「要素数」と「count の合計」のどちらが正しいかを見分けられない。後で配線する人が `{code:"X", count:3}` を 1 件渡すと「対象外 1 件」と出る。design.md:125 の「行数」とも合わない。
  - 提案: `excluded` を `UnmappedLine[]` にそろえて 1 つの型にする。あるいは、配線するまで `excluded`・`excludedCount` を置かない。

- [O-3] 種別: 実装 / 深刻度: mid
  - 指摘: `medicalMonthToLines` とその周りはどこからも呼ばれていない。テストは症例の行を ORCA 形式に変えて元に戻す往復で、実装をなぞっているだけになっている。
  - 破綻シナリオ: src/connect/orca.ts:150-204 の `OrcaMedicalMonth`・`loadCodeMap`・`medicalMonthToLines` と、それに付く環境変数 `RESEMEN_CONNECT_ORCA_CODEMAP`（docs/connectors.md:52 の表では、効く設定として載っている）、tests/connect/codemap-partial.json、テスト 4 本（tests/connect/connectors.test.ts:101-139）が、本番からは届かない。docs/connectors.md:83 自身が「どこからも呼ばれていない」と書いている。テストは `loadCase(k).lines` から `Perform_Calendar` を作り、同じ `lines` に戻ることを確かめているだけなので、ORCA の実際の形（1 日に複数回算定する場合を 0/1 の 31 文字では表せない、など）を何も確かめていない。運用者が CODEMAP を設定しても何も変わらない。
  - 提案: このブランチで足したコードなので削除する。docs/connectors.md には「xml2 に対応するときに書く」と 1 行だけ残す。表からも CODEMAP の行を消す。

- [O-4] 種別: 実装 / 深刻度: mid
  - 指摘: コネクタ層の本番への配線が使われていない。`enabledConnectors`・`connectorOf`・`app.checkConnectorPatient` を呼ぶルートがないのに、本番の compose が `RESEMEN_CONNECTORS`・`RESEMEN_CONNECT_ALLOW` を渡している。
  - 破綻シナリオ: deploy/docker-compose.yml:16-20 は「有効にするときだけ id と host:port を書く」と案内している。しかし src/connect/index.ts の 2 関数は本番から呼ばれず（テストだけ）、`checkConnectorPatient` も src/server/app.ts:45・92 で再 export されているだけで API がない。運用者が `RESEMEN_CONNECTORS=orca` を設定しても、何も起きない（失敗もしない）。設定が効いていないことに誰も気づけない。コネクタ自体は spec FR-110・112 の要求なので残すが、本番の環境変数と app の口は、要求のどこにも当たらない先回りになっている。
  - 提案: compose から 2 行を外し、app.ts から `checkConnectorPatient` を外す。呼ぶ API を作るときに一緒に足す。

- [O-5] 種別: 前提 / 深刻度: mid
  - 指摘: UKE のアップロードは、実際には見本とバイト単位で同じかどうかだけで受け入れを決めている。spec FR-05 の「取り込める UKE は見本に限らない」と食い違うが、この仮置きは design.md §8 の L 番号にも台帳にも載っていない。
  - 破綻シナリオ: src/server/app/uke.ts:65-73 では、`parseUke` の検査（src/uke/uke.ts。今回 181 行変更）を通ったファイルでも、`samples.findIndex(b.equals(buf))` に当たらなければ断る。当たった場合は `importUke(見本の名前)` と同じ結果になる。SHA-256 の名前で保存したファイル（:74-77）は読み返されない（docs/connectors.md:105）。つまり、行番号つきの検査・保存・ハッシュは、見本のボタンを押すのと同じ結果しか生まない。README.md:278 の「受け取るのは架空コードだけで作られた合成データで」は、一般の合成 UKE が通るように読める。仕様を読んだ人は FR-106 を満たしていると思い込む。
  - 提案: 仮置きを L 番号として design.md §8 に載せ、spec FR-05 の「見本に限らない」と並べて、ユーザーの判断を取る。README.md:278 にも「いまは見本と同じ内容だけ」と書く。

- [O-6] 種別: 実装 / 深刻度: low
  - 指摘: 日付・年月の小さな関数があちこちで重複していて、同じ名前で中身の違うものもある。
  - 破綻シナリオ: 次の箇所が重複している。`monthRange` は src/patient/profile.ts:92 と src/connect/types.ts:72 で中身が同じ。`addDays` は src/engine/rules/util.ts:32 と src/patient/checks.ts:124 で作り方が違う。`YEAR_MONTH` の正規表現は src/engine/revisions/index.ts:7・src/connect/types.ts:64・app/api/master/route.ts:10 にある。月をずらす処理は src/demo/period.ts:26 `monthFrom`・src/engine/revisions/index.ts:10 `nextMonth`・src/lifecycle/match.ts:63 `prevMonth` の 3 通り。`dayOf` は src/demo/period.ts:20（基準月の n 日）と src/server/rate-limit.ts:20（JST の日付）で、名前が同じで意味が違う。tests/helpers/period.ts も、period の関数に別名を付けているだけ。片方だけを直すと、月末や年またぎの扱いがずれる。
  - 提案: 年月・日付の関数は src/demo/period.ts か engine/rules/util.ts の 1 か所に寄せる。rate-limit の `dayOf` は `jstDay` などに改名する。

- [O-7] 種別: 実装 / 深刻度: low
  - 指摘: 算定画面がクライアント側で合計を足し直している。エンジンなら合計を出さない（null にする）点数未収載を 0 点として足すうえ、版は基準月に固定されている。
  - 破綻シナリオ: app/work/page.tsx:294 は `pointsOf(l.kubun) ?? 0` で足している。:128 では `/api/master` を `yearMonth` なしで呼ぶので、使われるのは基準月の版になる。今は未収載の区分もなく、症例もすべて基準月なので表には出ない。しかし、未収載の区分を足した版や基準月以外の症例があると、「合計 ○点」と出る一方で、`evaluate` は `total: null` を返す（src/engine/index.ts:37-40）。
  - 提案: 確定後は `confirmed.result.total` を使う。確定前は、未収載が 1 つでもあれば「—」にする。

- [O-8] 種別: 実装 / 深刻度: low
  - 指摘: `staleChoices` は計算されるが、どこでも捨てられている。
  - 破綻シナリオ: src/engine/derive.ts:340 で作るが、src/chart/claim.ts:47-61 の `claimPreviewOf` が落としていて、画面にもテスト以外にも届かない。日付の違う要選択に、前の答えを送り直した人には、無視されたことが伝わらない。
  - 提案: プレビューに「前の答えは使っていません」と出す。出さないなら、型と計算をやめる。

- [O-9] 種別: 実装（コメント・文書）/ 深刻度: low
  - 指摘: コメントや文書が、実装より古いままになっている。
  - 破綻シナリオ: 次の 4 つ。src/server/auth.ts:3「1 人 1 クリニック（src/server/tenant.ts）」→ そのファイルはなく、今は招待で 1 つのクリニックに複数人が入る。docs/demo-script.md:32「音声は未実装」→ README.md:86 と src/voice/ に ElevenLabs がある。docs/route-migration.md:21 は `idParams` を勧めている → それを使うルートが 0 件（src/server/schemas/common.ts:13）。README.md:285-295 の構成一覧に src/connect・src/official・src/patient・src/server が載っていない。読み手は、ないファイルを探したり、ある機能をないと思ったりする。
  - 提案: 該当の行を直す。

- [O-10] 種別: 実装 / 深刻度: low
  - 指摘: src/server/app.ts で、領域ごとの関数を分割代入で取り出し、同じ名前で return し直している。全部を 2 回書いていることになる。
  - 破綻シナリオ: :43-62 の分割代入と :64 以降の return が、同じ名前の一覧を 2 回持っている（約 100 行）。領域に関数を 1 つ足すと 2 か所を直す必要があり、片方を忘れると型エラーではなく「呼べない」になる（return に載せ忘れた場合）。`checkConnectorPatient`（O-4）のように、使われない口も紛れ込みやすい。
  - 提案: 名前を変えるもの（`confirm: confirmQ` など）と合成するもの（`chartClaim` など）だけを明示し、残りは `...clerks` のように展開して返す。
