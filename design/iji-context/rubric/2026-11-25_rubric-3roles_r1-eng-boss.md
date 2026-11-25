# 採点 r1：役 2「エンジニアの上司（技術とプロセスを見る）」（2026-11-25）

基準：`rubric/2026-11-25_rubric-3roles_v1.md` の役 2 と減点。
対象：コード `.claude/worktrees/fr211`（HEAD 3191be0）、文書 `.claude/worktrees/readme`（HEAD 697e96b）の README.md・docs/、`design/iji-context/` の spec.md・design.md・ledger.md（作業ツリーの最新）、手元の確認用サーバー http://localhost:3109（curl だけ）。

AI の採点は、実際の審査や評価の予測ではない。

## 合計：80 / 100

| 観点 | 配点 | 点 |
|---|---|---|
| 構成と技術選定の説明 | 20 | 16 |
| 判定の決定性と AI の境界 | 25 | 21 |
| テストと検査 | 20 | 17 |
| セキュリティとデータ | 20 | 16 |
| 引き継ぎやすさ | 15 | 10 |
| 減点 | — | 0 |

## 観点ごとの点と理由

### 構成と技術選定の説明 16/20
良い点
- README に構成図（Mermaid）・技術スタックの表・「設計の芯」がある（README.md:94-128）。
- 表の記述がコードと合う：モデルの割り当ては `config/models.json`（mentor=Sonnet、veteranMentor=Opus、scribe/chartSoap=Haiku）と一致。パスワードの scrypt は `src/server/auth.ts:1,30`。外部への出口が 1 つは `src/llm/outbound.ts:1`。フォルダの表（README.md:168-192）も実在のフォルダと合う。

減点の理由
- FR-211 の説明がコードと合わない。README.md:25 は「仕様では…医師確認で毎回聞くと決めています（FR-211）」と書くが、コードは辞書方式。Lv.5 以上の事務は医師確認を選ばずに済み（`src/server/app/notes.ts:131,196`）、医師の答えはクリニックの辞書 `abbrev_dictionary` に覚える（`src/server/app/doctor-abbrevs.ts:243-245`）。
- 「UKE の中身（氏名・番号・診療行為）は AI に送りません」（README.md:77、docs/security.md「外部へ出るデータ」の表の下）は書きすぎ。メンターには、ユスティの判定の行（lineRefs）と過去月の算定の区分を送っている（`src/mentor/prompt.ts:116,123`、`src/llm/outbound.ts` の `claimForAi` が history.kubun を写す）。どちらも UKE の診療行為から作る値。同じ security.md の表には「ユスティの判定（ルール・行・指摘）」「過去月の算定の区分」を送るとあり、文書の中でも食い違う。
- README の worktree（docs/readme）とコードの worktree（feat/fr211）で docs/ の中身がずれている。readme にある `docs/checks.md` が fr211 になく、fr211 にある `docs/review-consent.md` が readme にない（`git ls-files docs` の比較）。マージの前は、README のリンクがコードの側で切れる。

### 判定の決定性と AI の境界 21/25
良い点
- Agent SDK を読み込むのは `src/llm/outbound.ts` だけ。テストがソースを走査して縛る（`tests/llm/outbound.test.ts`）。`src/engine`・`src/generic` は LLM も mentor も読み込まない（grep で 0 件）。
- 送る直前に、同意を DB から読み直す（`outbound.ts` の `assertMaySend`）。ルートの入口の申告とは別の、二重の確かめ。
- カルテから取り出した事実は、quote がカルテにない事実を規則で捨てる（`src/chart/extract.ts` の `validateFacts`）。判定に入るのは本人が確定した事実だけ（`facts IS NOT NULL`。`src/server/app/notes.ts:577`）。確定のときに quote をもう一度確かめる（同 :113-121）。
- 通知の PDF の読み取り（LLM）は、患者・区分への対応づけを規則で行い（`src/notice/notice.ts` の `resolveNotice`）、知識にするのは人が登録したときだけ。
- 医師確認の 7 要件は規則で確かめる。点数・金額の語は正規表現ではじき、「その他」「判定不能」がなければ断る（`src/query/doctor-query.ts:14,27,29`）。メンターが医師確認を作る前には、Hooks で、関係する決まりを読んだかを確かめる（`src/mentor/session.ts` の `doctorReadGuard`）。
- FR-211 の止め方は規則だけで決まる（`abbrevModeOf`）。止めているあいだは LLM の lookup を外し、書き方の対応を覚えない（`notes.ts:404-406,452-455`）。

減点の理由
- LLM が分類まで決めて、その値が算定の判定に入る道がある。処方は「薬の名前で書かれていても分類名で value に入れる」（`extract.ts:75`）。不安・不眠の薬の「あり／なし」も LLM が決め（`extract.ts:78`）、確定すると処方の出来事の psychotropic に重なって R07（処方箋料の区分 2）に効く（`src/chart/notes.ts:31-33`）。本人の確定は挟まるが、確定の API が確かめるのは quote がカルテにあるかだけで、分類が正しいかは見ない（`notes.ts:113-121`）。医薬品マスターで決められる分類を LLM に任せており、人の確かめが形だけになりうる。
- 1 人で使っているクリニックの持ち主は、役割を「医師」に切り替えて、医師確認の回答と承認を自分でできる（`src/server/auth.ts:202-205` は isSolo だけを見る。権限表 `src/server/policy.ts:71` の approve は doctor）。手元のサーバーで、grader-eng から `POST /api/auth/role {"role":"doctor"}` が 200 を返すことを確かめた。実在のデータのクリニックでも同じなので、「医師の承認」を医師でない人が記録できる。監査ログには残る。
- FR-211 の辞書方式では、Lv.5 以上の事務が辞書の意味を選ぶと、医師を通さずに止めが解け、LLM の lookup と初期値が戻る（`notes.ts:131,196,212-215`）。利用者が承認した決め（plan-fr211.md「辞書方式の決め」）のとおりだが、spec.md の FR-211（「答えはクリニックごとに覚えず、毎回聞く」「医師の答えが来るまで LLM の lookup の候補を出さず」）とは違う。

### テストと検査 17/20
実行の結果（fr211 で自分で実行）
- `npm run -s typecheck`：exit 0
- `npx vitest run`：183 ファイル中 173 合格・10 飛ばし、2460 合格・119 飛ばし、exit 0
- `RESEMEN_MASTER_DIR=…/masters-v34 npx vitest run`：183 ファイル合格、2577 合格・2 飛ばし、exit 0
- `check:dates` 0 件、`check:banned-words` 190 ファイルで 0 件、`check:codes` 338 ファイルで 0 件、`check:masters` 失敗 0・警告 0（いずれも exit 0）
- `scripts/check-bundles.ts`（マスターあり）：「群と号の対応：すべて合っています」、exit 0
- CI（`.github/workflows/ci.yml:32-47`）：npm ci・typecheck・test・build・npm audit（high）・banned-words・dates・codes

減点の理由
- CI が見るのはマスターなしの vitest だけ。G01〜G12 のテスト（マスターなしでは 117 件飛ぶ）、`check:masters`、`check-bundles` は CI で回らず、手元の実行だけが頼り。データで動く点検という重要な部分が、CI では守られていない。
- `check-bundles.ts` は README の検査の一覧（README.md:139）にあるのに、npm script にも CI にもない。
- build は時間の都合で実行していない（CI には入っている）。GitHub Actions の実績も見ていない。

### セキュリティとデータ 16/20
良い点（コードと API で確かめた）
- すべての API（107 本）が `route()` を通る（`find app/api -name route.ts` で route( を含まないファイルは 0）。順番はログイン→ロール→使い方の決まり→同意→回数制限→スキーマ→処理→監査ログ（`src/server/http.ts`）。
- 入力は zod の strictObject。余計な項目は断る（`{"version":"1","userId":"x"}` → 400 `項目：userId`）。content-type が違えば 415。
- ログインしていなければ 401（`GET /api/cases`）。事務の役割では `/api/audit`・`/api/masters` は 403。
- Origin の違う POST は 403（`Origin: https://evil.example` で確かめた）。CSP・X-Frame-Options: DENY・Referrer-Policy が出ている。
- 監査ログには、失敗した操作（415・400）も result 付きで残る（`GET /api/audit` で確かめた）。本文は残さない。
- クリニックごとに DB を分ける（`runAs`）。秘密は `.gitignore` で外し、追跡されているファイルに API キーの形の文字列はない（`git grep` で 0 件）。

減点の理由
- 上に書いた、1 人のクリニックで医師の役を自分で兼ねられる件。
- 保存時の暗号化がなく、CSP の script に 'unsafe-inline' がある。どちらも docs/security.md の残余リスクに書いてあるので、減点は小さく取った。
- 外部に出るものの説明は、上に書いたとおり README と security.md で食い違う（「診療行為を送らない」）。

### 引き継ぎやすさ 10/15
良い点
- spec.md（956 行）・design.md（3563 行）・ledger.md（538 行）・handoff-opus.md・reviews/（201 ファイル）・docs/ の手順書（デプロイ・改定・ルートの足し方）がそろっている。判断の経緯は ledger に日付付きで残る。

減点の理由
- 「正」とする spec.md が FR-211 の実装より古い。spec.md:561 は「答えはクリニックごとに覚えず、毎回聞く」のままで、承認された辞書方式（plan-fr211.md:110-119、ledger.md:524-537）を反映していない。CLAUDE.md は spec.md を正とするので、次の人が spec.md を読むと、コードを誤りと読む。
- FR-211 の計画と批評・反証の記録がコミットされていない。plan-fr211.md・reviews/round-96〜103・fable-consult-fr211.md・rubric/ は未追跡で、spec.md・ledger.md・handoff-opus.md の変更も未コミット（メインの作業ツリーの `git status`）。クローンした人には届かない。
- ブランチが 4 本に分かれている（main の作業ツリーは docs/spec-r8、コードは feat/fr211、README は docs/readme、土台は feat/integration）。どれが最新かは、依頼文が説明しないと分からない。
- design.md は 3563 行あり、入口の目次や要約がないと読み切れない。handoff-opus.md（108 行）がその代わりをしているが、FR-211 は「受け入れ条件 7（画面）はまだ」（ledger.md:537）で止まっている。

## 減点（配点とは別）
- 一次資料と食い違う数字：0 件。README.md:13 の 334 万円・約 33,000 件／約 18,000 件・約 0.40%・0.460% は evidence-master の 1-1・9-1・4-1・4-2 と一致し、出典のリンクもある。
- 出典のない数字：0 件
- 言い過ぎ：0 件。「診療行為を送らない」は言い過ぎに近いが、security.md の表で送るものを正しく挙げているので、文言の食い違いとして観点の中で引いた。
- 相関を因果と書く：0 件

## 役の納得：△
設計の芯（判定は規則、LLM の出口は 1 つ、同意を二重に確かめる、quote で作り足しを捨てる）は、コードとテストで本当に守られている。テストも検査も全部通る。エンジニアの上司として、技術はおおむね信頼できる。
それでも ○ にしない理由は 3 つ。(1) 正とする spec.md と FR-211 の実装が食い違ったまま、記録がコミットされていない。(2) 1 人のクリニックでは医師の承認を医師でない人ができる。(3) マスターありのテストが CI にない。

## 指摘の表

| # | 重大度 | 区分 | 場所 | 起きる状況 | 根拠 |
|---|---|---|---|---|---|
| 1 | P1 | 中身 | src/server/auth.ts:202-205、src/server/policy.ts:71 | 1 人で使う実在のデータのクリニックで、持ち主が医師に切り替え、医師確認の回答・承認と代行入力の承認を自分でする。傷病名の確定（FR-32）まで医師を通らない | 手元のサーバーで `POST /api/auth/role {"role":"doctor"}` が 200。switchRole は isSolo だけを見る |
| 2 | P1 | 中身 | design/iji-context/spec.md:561 と src/server/app/doctor-abbrevs.ts:243-245、notes.ts:131,196 | 次の人が正の spec.md を読み、辞書に覚える・Lv.5 から任意という実装を誤りと判断する | spec は「覚えず、毎回聞く」。コードは abbrev_dictionary に INSERT し、Lv.5 以上で askDoctor は任意 |
| 3 | P1 | 中身 | メインの作業ツリーの git status | FR-211 の計画・反証の記録（plan-fr211.md、round-96〜103）と spec・ledger の変更が未コミット。作業ツリーが消えると記録が失われ、ほかの人にも届かない | `git status --short` で ?? と M |
| 4 | P1 | 中身 | .github/workflows/ci.yml:32-47 | G01〜G12 を壊す変更が CI を通る。マスターなしでは 117 件のテストが飛ぶ | マスターなしは 2460 合格・119 飛ばし、マスターありは 2577 合格・2 飛ばし。CI に RESEMEN_MASTER_DIR・check:masters・check-bundles がない |
| 5 | P2 | 中身 | src/chart/extract.ts:75,78、src/chart/notes.ts:31-33、notes.ts:113-121 | LLM が付けた「不安・不眠の薬：あり」を本人がそのまま確定し、R07 の処方箋料の区分 2 の判定に入る。確定の API が見るのは quote だけ | 分類は医薬品マスターで規則にできる。人の確かめが形だけになりうる |
| 6 | P2 | 文言 | readme/README.md:25 | 読んだ人が、FR-211 は仕様だけで未実装、しかも毎回医師に聞くと受け取る | 実装は辞書方式（Lv.4 までは必ず医師確認、Lv.5 からは任意） |
| 7 | P2 | 文言 | readme/README.md:77、readme/docs/security.md「外部へ出るデータ」の表の下 | 「診療行為は AI に送らない」と読んだ導入側が、判定の行と過去月の区分が送られることを見落とす | src/mentor/prompt.ts:116,123、claimForAi の history |
| 8 | P2 | 中身 | docs/（readme と fr211） | マージの前は、README のリンク docs/checks.md がコードの側にない | `git ls-files docs` の差 |
| 9 | P2 | 文言 | readme/README.md:139 | check-bundles を検査として挙げているのに、npm script にも CI にもない。誰も回さなくなる | package.json の scripts |

P0：0 件。

## 100 点に届くための直しの順
1. spec.md の FR-211 を辞書方式（plan-fr211.md の決め）に書き直し、plan・reviews・ledger・handoff と一緒にコミットする（#2・#3）。
2. 役割の切替で医師になれるのを、demo のクリニックだけにする。実在のデータのクリニックでは、医師の役は招待した別の人に限る。テストも足す（#1）。
3. CI に、マスターありのジョブを足す。CI の中でマスターを落とすか、取り込み済みの小さな見本の masters.db を用意して、`check:masters`・`check-bundles` も回す（#4・#9）。
4. 不安・不眠の薬と処方の分類は、医薬品マスターの規則で決める。LLM の値は候補として見せるだけにする。または、確定の API で分類ごとに本人の「確かめた」を要求する（#5）。
5. README.md:25・:77 と security.md の文を、実装と送るものの表に合わせる（#6・#7）。docs/readme と feat/fr211 をマージして、docs/ をそろえる（#8）。
6. design.md の頭に、章ごとの要約と FR ごとの索引を置く。

## 確信度と見られなかったもの
- 確信度：中〜高。境界・認可・テストの結果は、コードを読み、コマンドと API で確かめた。分量が多いので、全ルート・全ルールの読み込みはしていない（抜き取り）。
- 見られなかったもの：`npm run build`（時間の都合）。GitHub Actions の実行の実績。画面（ブラウザのペインは使えない）。LLM を呼ぶ API の実際の応答（カルテの取り出し・メンター。外部への送信と回数の制限を避けた）。テスト以外の、ほかのクリニックからの実際のアクセスの試し（ほかの人のデータに触れないため）。
- 採点の手順での事故：作業の初めに、共有の scratchpad の cookie のファイル名（cj.txt）がほかの採点者とぶつかった。そのせいで、`POST /api/consent {"version":"1"}` を 1 回、grader-manager のセッションで送ってしまった（応答 200。grader-manager の監査ログと auth_events に同意の記録が 1 行増えた可能性がある）。そのあとは自分専用のフォルダの cookie で grader-eng としてやり直した。それ以外に、ほかの人のデータには触れていない。
