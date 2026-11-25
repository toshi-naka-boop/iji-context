# 採点 r2：エンジニアの上司（技術とプロセスを見る）

- 基準：`rubric/2026-11-25_rubric-3roles_v1.md` の「役 2」と「減点」（ほかの回の結果は開いていない）
- 対象：worktree `.claude/worktrees/rubric-r1`（ブランチ feat/rubric-r1、HEAD 7ddb644）、README.md・docs/、`design/iji-context/` の spec.md・design.md・ledger.md・plan-fr211.md（メインのチェックアウトのもの）、http://localhost:3109（curl）
- 採点日：2026-11-25。AI の採点は、実際の審査や評価の予測ではない

## 合計：80 / 100

| 観点 | 配点 | 点 |
|---|---|---|
| 構成と技術選定の説明 | 20 | 17 |
| 判定の決定性と AI の境界 | 25 | 22 |
| テストと検査 | 20 | 16 |
| セキュリティとデータ | 20 | 16 |
| 引き継ぎやすさ | 15 | 9 |
| 減点 | — | 0 |

## 観点ごとの点と理由

### 構成と技術選定の説明 17 / 20
- 良い点：README に Mermaid の構成図、技術スタックの表、「設計の芯」、フォルダの表がある。コードと合っていることを確かめた：
  - R01〜R21 は `src/engine/rules/r01.ts`〜`r21.ts`、P01〜P08 は `src/patient/checks.ts`、G01〜G12 は `src/generic/` にある
  - モデルの割り当ては `config/models.json` のとおり（メンター Sonnet、ベテランのメンター Opus、整文 Haiku）
  - 外部の SDK を読み込むのは `src/llm/outbound.ts` と `src/voice/elevenlabs.ts` だけ（`git grep` で確かめた）
  - マイグレーションは `src/db/migrate.ts` の連番。CI の手順は README の記述と一致する
- 減点：
  - README の「資料」は spec.md・design.md・ledger.md にリンクしているが、このブランチにあるのは 11-05〜11-08 の古い版。design.md は v21 で §15 がなく、コードのコメントは §11〜§15 を 126 か所で参照している。README から設計へたどると、コードと食い違う（-2）
  - フォルダの表に `src/note14`・`src/practice`・`src/prevented`・`src/demo` がない（-1）

### 判定の決定性と AI の境界 22 / 25
- 良い点：
  - ユスティ（`src/engine`）・G 系（`src/generic`）・突き合わせ（`src/review`）・知識の状態（`src/lifecycle`）は、LLM の出口を読み込んでいない
  - SDK を読み込むのは `outbound.ts` だけで、テストがソースを走査して縛っている
  - カルテから取り出した事実は保存の時点では使われない。本人の `confirmNote`（`src/server/app/notes.ts:113`）で quote を検証し直したものだけが、`confirmedNotes` から判定に入る
  - LLM の呼び出しは `tools: []`・`settingSources: []`・`persistSession: false` で閉じている。メンターが使えるのは Skill と自前の MCP ツールだけ
  - 医師確認を作る前に Hooks（`doctorReadGuard`）が、関係する決まりを読んだかを確かめる
  - ヒントの段階の答えの漏れは、決まった規則（`leakedTerms`）で見る
  - 知識の状態の遷移表（`src/lifecycle/machine.ts`）で承認済みに上げる主体は、ベテランと、決まった規則の system だけ
- 減点：
  - メンター（LLM）が書いた医師確認は、事務が読まずにそのまま「未回答」として医師に届く（`src/mentor/session.ts:50` → `createQuery`）。検証の `validateQuery` は、誘導の言い回しを正規表現の一覧で見るだけ（`src/query/doctor-query.ts:16`）。言い回しを変えた誘導は通る（-2）
  - 「不安・不眠の薬」の該当かどうか（R07 の処方箋料の区分に効く）は、LLM が薬の分類を判断する（`src/chart/extract.ts:78`）。本人の確かめはあるが、薬の分類を知らない事務が追認するだけになりやすい（-1）

### テストと検査 16 / 20
- 自分で実行した結果（すべて終了コード 0）：
  - `npm run -s typecheck`：通った
  - `npx vitest run`（マスターなし）：177 files passed / 10 skipped、2472 passed / 119 skipped
  - マスターあり（`RESEMEN_MASTER_DIR=…/masters-v34`）：187 files passed、2589 passed / 2 skipped
  - `check:dates`・`check:banned-words`・`check:codes`：0 件
  - `check:masters`：データなしでは「飛ばした」で 0。データありでは錨 122/122・式の錨 23/23・版の表との食い違い 0
- 減点：
  - このブランチは CI を一度も通っていない。`gh run list` の最後は 11-23 の feat/integration。そこから HEAD まで 146 コミット、264 ファイル、+15,989 行あり、build と `npm audit` を CI で確かめていない（-3）
  - build は、動いている確認用のサーバーの `.next` を壊すおそれがあるので、こちらでも回していない（-1。満点の条件の「build が通る」を確かめられない）

### セキュリティとデータ 16 / 20
- 良い点：curl と読んだコードで確かめた。
  - 同意の前に患者データのルートを叩くと 403（`{"consent":"required"}`）
  - Origin がほかのサイトなら 403
  - 版の違う同意は 409。知らない項目は 400（zod の strictObject）
  - ログインなしは 401。`claimId` に `../` を入れると 400
  - 全 113 ルートが `route()` を通る。権限表の申告は必須で、既定値がない
  - 同意は入口と出口（`assertMaySend` が DB を読む）の 2 か所で確かめる
  - 監査ログは id だけを残す
  - クリニックごとに DB を分け、職員の操作は `staffOf` で同じクリニックの人に限っている
  - コネクタは許可リスト、DNS の結果の固定、内部 IP の拒否を持つ
  - 秘密の値は Secret Manager か環境変数。リポジトリにキーの形の文字列はない（`git grep` で確かめた）
- 減点：
  - 公開版でも実在の患者データを受けるのに、保存時に暗号化していない（docs/security.md:88）。記載はあるが、要配慮個人情報を公開のサーバーに平文で置く設計のまま（-2）
  - クリニックの削除は、確かめの欄に持ち主のログイン ID を入れるだけで、パスワードを入れ直さない（`src/server/auth.ts:283`）。セッションを奪われると、全データをすぐ消せる（-1）
  - 事務長は、持ち主の役割と自分の役割を変えられる（`src/server/auth.ts:251` の `setStaffRole` は、相手が持ち主かを見ない）。持ち主は `isOwner` で職員の管理を続けられるので実害は小さいが、意図した仕様かが文書にない（-1）

### 引き継ぎやすさ 9 / 15
- 良い点：docs/ は 11 本ある（checks・masters・security・route-migration・revision-howto・deploy-gcp など）。ledger.md（未解決なし）と reviews/ に批評・反証の記録が残り、量と粒度は十分。
- 減点：
  - 最新の仕様・台帳・計画が、どのブランチにもコミットされていない。メインのチェックアウトで `spec.md`・`ledger.md` は変更したまま（` M`）、`plan-fr211.md` と round-100〜103 の記録は未追跡（`??`）。今のブランチは docs/spec-r8。次の人が clone しても、FR-211 の仕様と計画が手に入らない（-4）
  - コードのブランチの design.md は v21（11-05）。最新の design.md は v31 で「未承認」と書かれている。コードがどの承認済みの版に沿っているかを、文書から追えない（-2）

## 減点（配点とは別）
なし。README の数字（334 万円・約 33,000 件／約 18,000 件・約 0.40%・0.460%）は、どれも出典の URL があり、evidence-master の 1-1・9-1・4-1・4-2 と一致した。言い過ぎと、相関を因果と書いた箇所は、技術の範囲では見つからなかった（「効果は測っていません」と明記している）。

## 役の納得
**△**。設計の芯（判定は決まった規則、LLM は読む・話す・整えるだけ）がコードの構造で守られ、テストも 2,500 件超が通る。技術としては信頼できる。ただ、次の 2 つがそろわないと、引き継いで任せられない：
- 出そうとしているコードが CI を通っていない
- 最新の仕様と計画が版の管理の外にある

## 指摘の表

| # | 重大度 | 区分 | 場所 | 起きる状況 | 根拠 |
|---|---|---|---|---|---|
| 1 | P1 | 中身 | `design/iji-context/spec.md`・`ledger.md`（変更したまま）、`plan-fr211.md`・`reviews/round-100〜103`（未追跡） | 次の担当者が clone すると、FR-211 の仕様と計画がなく、3 週間前の spec を読む | メインのチェックアウトの `git status`。worktree の spec.md の最終コミットは 5f4a620（11-08）で、FR-211 の記述が 0 件 |
| 2 | P1 | 中身 | ブランチ feat/rubric-r1 全体 | build・npm audit を確かめていない 146 コミット（+15,989 行）を提出・マージする | `gh run list` の最後は 11-23 の feat/integration。`git log origin/feat/integration..HEAD` は 146 件 |
| 3 | P1 | 中身 | docs/security.md:21・88、README.md:100 | 公開版に入れた実在の患者データが、ディスクに平文で残る。サーバーを奪われると全部漏れる | docs/security.md の脅威モデルの「対策なし」 |
| 4 | P2 | 中身 | `src/mentor/session.ts:50`、`src/query/doctor-query.ts:16` | LLM が書いた医師確認が、事務を通らずに医師へ届く。誘導の検出は言い回しの一覧だけ | `createQuery` が状態を「未回答」で保存する |
| 5 | P2 | 中身 | `src/chart/extract.ts:78` | 薬の分類（不安・不眠の薬）を LLM が判断し、事務の追認で R07 に入る | `confirmNote` は quote を検証するが、分類の正しさは見ない |
| 6 | P2 | 中身 | `src/server/auth.ts:283` | セッションを奪われると、クリニックをすぐ消せる | 確かめはログイン ID だけで、パスワードを入れ直さない |
| 7 | P2 | 中身 | `src/server/auth.ts:251` | 事務長が持ち主の役割を変える。仕様に書かれていない | `setStaffRole` は相手が持ち主かを見ない。`tests/server/staff.test.ts` にこの場合のテストがない |
| 8 | P2 | 文言 | README.md:237〜240 | README から設計へたどると、このブランチでは v21 の design.md に着く | worktree の design.md に §15 がない |
| 9 | P2 | 文言 | README.md:192 のフォルダの表 | `src/note14`・`practice`・`prevented`・`demo` の役割が分からない | `ls src` との突き合わせ |
| 10 | P2 | 文言 | docs/security.md:25 | 「外部へ送る処理は 2 か所だけ」とあるが、コネクタ（`src/connect/fetch.ts`）も外へ要求を出す | 同じ文書の後ろの段で触れてはいる |
| 11 | P2 | 文言 | README.md:100 | 「AI のサービスに送った内容は消せません」が同じ段落に 2 回ある | — |

## 100 点に届くための直しの順
1. 最新の spec.md・ledger.md・plan-fr211.md・reviews/ をコミットし、コードのブランチに取り込む。design.md の最新版の承認の状態と、コードがどの版に沿うかを README に 1 行書く（#1・#8。+6 前後）
2. feat/rubric-r1 を push して PR にし、CI（build・audit を含む）を通す（#2。+4）
3. 保存時の暗号化（ディスクの暗号化、または DB と ファイルの暗号化）を入れるか、公開版で実データを受ける条件を運用の手順として書く（#3。+2）
4. メンターの書いた医師確認を、事務の確かめを経てから送るようにする。誘導の検出をテストの見本で広げる（#4。+2）
5. クリニックの削除にパスワードの入れ直しを足す。事務長が持ち主の役割を変えられるかを決めて、テストにする（#6・#7。+2）
6. 「不安・不眠の薬」に当てた薬の名前を、確かめる画面で事務に見せる。または医師確認に回す（#5。+1）
7. README のフォルダの表、security.md の言い回し、重なった文を直す（#9〜#11。+1）

## 確信度と見られなかったもの
- 確信度：中〜高。境界・認可・テストはコードと実行の結果で確かめた。引き継ぎの減点は `git status` と `git log` による。
- 見られなかったもの：
  - `npm run build`：動いている確認用のサーバーの `.next` を壊すおそれがあり、回していない
  - CI のこのブランチでの結果：まだない
  - 画面（ブラウザのペインが使えない）
  - LLM を呼ぶ経路の実際の応答：費用がかかるので呼んでいない
  - ほかのクリニックとの分離：ほかの人のデータに触れないため、1 アカウントだけで、コードとテストの存在で確かめた
  - 公開版（sslip.io）
  - 一次資料（告示・通知）と数字の照合：evidence-master との一致までを確かめた
