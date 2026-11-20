# 次の改定で版を足す手順

診療報酬の改定（偶数年 6 月）や、同じ改定の中での値の変更があったときに行う作業です。
点数とルールは「改定の版」に属し、診療年月から版を 1 つに決めます。該当する版がない診療年月は判定しません（近い版で代用しません）。

- 版の置き場：`src/engine/revisions/`（版 1 つ＝ファイル 1 つ。今は `r2026.ts` と、その値の変更の `r2027-06.ts`。請求の判定に使う版の一覧は `REVISIONS`）
- 改定の比較と試算の表示にだけ使う前の版は、`COMPARE_REVISIONS` に置きます（今は `r2024.ts`。値は EM §2-9。ルールとコードは持たず、請求の判定には使いません）
- 既存の版のファイルは書き換えません。足すだけです
- 数字・区分番号・要件は、EM（`design/iji-context/sources/evidence-master-iji-context.md`）の採用値だけを使います

## 1. EM に新しい採用値を追記して、承認を取る

告示・留意事項通知・訂正通知・疑義解釈を一次資料で確かめ、点数表（区分キー・区分番号・点数・出典）と、変わった要件を EM に足します。
承認が出るまで、コードには値を書きません。

## 2. 版のファイルを 1 つ足す

- 改定のとき：`rYYYY.ts` を新しく作り、点数表（`points`）・定数（`consts`）・ルール一式（`rules`）を持たせます。`kind` は「改定」、`generation` は新しい改定の名前にします
- 値だけが変わるとき：`extendRevision(直前の版, { id, label, effectiveFrom, effectiveUntil, points })` で、変わる区分の点数だけを書きます（区分・定数・ルールは足せません）
- 直前の版の `effectiveUntil` と、新しい版の `effectiveFrom` を続けます（空白・重なりは読み込み時に例外になります）。直前の版の終了月を変える必要があるときは、その 1 行だけを直し、理由を EM に残します
- `src/engine/revisions/index.ts` の `REVISIONS` に足します
- **前の版を `REVISIONS` から `COMPARE_REVISIONS` へ移すかを決めます**。`REVISIONS` に残すと、その版の診療年月の請求を今までどおり判定します（遅れて出す請求・再請求のため）。`COMPARE_REVISIONS` へ移すと、その診療年月には版がなくなり、改定の比較と試算でだけ選べます。移した版が持つ `rules`・`codes` はそのままで構いません（比較用の版に掛かる検査は、id・期間の形・点数表だけです）
- **新しい版の `changes` を書きます**。前の改定から変わった点（新設・廃止・点数・要件・区分の再編）を、EM に「変わった点」の表として足して承認を取ってから、その行を写します（今の版は `r2026-changes.ts`。表の行と 1 対 1 であることを `tests/engine/compare.test.ts` が縛ります）。値の変更の版（`extendRevision`）は `changes` を持ちません
- 版で有無が変わる導出（新設・廃止の区分）は、`src/engine/derive.ts` が「その版の点数表に区分があるか」で決めます。if 文に版の id を書きません。版で読む・読まないが変わる施設の設定は、版の定数（例：`consts.kanri.note16.enabled`）で切り替えます
- 要件が変わったルールは `src/engine/rules/` の工場関数と `src/engine/predicates.ts` を直します。区分・閾値はルールに直書きせず、版の定数で渡します。番号（R01…）は振り直さず、新設は続きの番号にします
- 指摘のキーを足したら `src/messages.ts` に文を足し、制度層の知識の文（`scripts/seed-knowledge.ts` の `RULE_TEXT`。点数は書かない）も合わせます

## 3. 診療行為コードを版に持たせる

診療行為コードは版が持ちます（`Revision.codes`・`bundles`・`uncoded`・`shikibetsu`。今の版は `src/engine/revisions/r2026-codes.ts`）。改定でコードは廃止・新設されるので、新しい版には新しい表を書きます。値の変更の版（`extendRevision`）は、直前の版の表を引き継ぎます。

1. 厚生労働省 診療報酬情報提供サービスの「ファイルダウンロード」から、その改定の医科診療行為マスターを取ってきます（リポジトリには入れません）
2. EM §2-8 の表（区分キー・コード・マスターの名称・マスターの点数・診療識別）を新しい改定の行に直し、承認を取ります。コードを 1 つに決められない区分は表に入れず、候補と理由を書きます
3. 版の表を書きます。EM にある区分は `codes`（`primary` は書き出しに使う 1 つ、`accept` は読み取りで同じ区分として受けるほかのコード）、項目数で区分が決まる検査は `bundles`、EM にない・1 つに決まらない区分は `uncoded` に理由つきで載せます。点数表の各区分は、この 3 つのちょうど 1 つに載せます（読み込み時に検査します）
4. マスターと突き合わせます。食い違いが 0 件になるまで、テストを通すために片方を直さず、原文で確かめてから EM を直します

```bash
npx tsx scripts/check-codes.ts <医科診療行為マスターの CSV>
```

区分のキーは、区分番号やコードが変わっても変えません（変わるのは点数表の `no` と、版の `codes`）。コードから区分を引く処理は、必ず先に版を決めます（同じコードが、別の版では別の区分キーに当たることがあります）。
`src`・`scripts`・`fixtures` と同梱の UKE に、以前の作り物のコード（99 で始まる 9 桁）が残っていないことは `npm run check:codes` で確かめます。

## 4. 症例・見本の UKE・練習問題を作り直す

- EM 5-1 の症例と §5-2 の合計を新しい版の値で作り直し、承認を取ります
- `config/demo.json`（診療年月・請求月・時計の初期値・データの版の印）、`config/business-days.json`（祝日）、`config/facility.json`（施設の設定）を直します
- `fixtures/cases/`・`fixtures/charts/`・`fixtures/uke/patients.json`・`fixtures/notices/` を直し、`npx tsx scripts/gen-uke.ts`・`npx tsx scripts/gen-connect.ts`（連携の模擬データ。gen-uke のあと）・`npx tsx scripts/gen-notice.ts`・`npx tsx scripts/seed-knowledge.ts` で作り直します
- 練習問題（`src/practice/`）が、新しいルールでも「違反を探す」題材になっているかを確かめます
- すでに動いている環境のデータは、印が違う置き場の一覧を出して承認を取ってから退避します（`npx tsx scripts/reset-demo.ts --retire-stale`。消しません）

## 5. 公的情報レジストリの適用版を見直す

疑義解釈・審査の取扱いなど、要旨とリンクで持っている公的文書が、新しい版でも当てはまるかを 1 件ずつ確かめます。

- 文書は `official/<id>.json` に 1 件 1 ファイルで置いています。置けるのは EM §2-4 の表にある文書だけです（表にない id は `tests/official/registry.test.ts` が落とします）
- 新しい版でも当てはまる文書は、`generations` に新しい改定を足します。当てはまらなくなった文書は足しません（その版の請求との突き合わせに使われなくなります）
- 立場・対象区分・条件を直した文書は、確認済みの扱いが外れ、矛盾の恐れがあるローカルルールが次のレセメン会議の議題に出ます。要旨・URL・確認日だけの直しでは出ません
- EM §2-4 の表の確認日と立場も合わせて見直します

## 6. 自動テストと、README・CLAUDE.md の固定条件を更新する

```bash
npm run typecheck && npm test && npm run check:dates && npm run check:codes && npm run build
npx tsx scripts/gen-uke.ts && git diff --exit-code fixtures/uke
npx tsx scripts/gen-connect.ts && git diff --exit-code fixtures/connect
```

- ルールごとの合格・不合格の最小例（`tests/engine/rules/`）、症例の合計（`tests/engine/totals.test.ts`）、版の境界（`tests/engine/revisions.test.ts`）、改定の比較（`tests/engine/compare.test.ts`）を新しい版に合わせます
- テストの年月・日付は `tests/helpers/period.ts` から作り、直書きしません。`src`・`app`・`scripts` に年月を直書きすると `check:dates` が落ちます
- README の「守っていること」と、CLAUDE.md の固定条件（診療年月・改定年度）を直します
