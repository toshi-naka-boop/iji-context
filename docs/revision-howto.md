# 次の改定で版を足す手順

診療報酬の改定（偶数年 6 月）や、同じ改定の中での値の変更があったときに行う作業です。
点数とルールは「改定の版」に属し、診療年月から版を 1 つに決めます。該当する版がない診療年月は判定しません（近い版で代用しません）。

- 版の置き場：`src/engine/revisions/`（版 1 つ＝ファイル 1 つ。今は `r2026.ts` と、その値の変更の `r2027-06.ts`）
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
- 要件が変わったルールは `src/engine/rules/` の工場関数と `src/engine/predicates.ts` を直します。区分・閾値はルールに直書きせず、版の定数で渡します。番号（R01…）は振り直さず、新設は続きの番号にします
- 指摘のキーを足したら `src/messages.ts` に文を足し、制度層の知識の文（`scripts/seed-knowledge.ts` の `RULE_TEXT`。点数は書かない）も合わせます

## 3. 架空コードの表に行を追記する

`src/engine/codes-fictional.ts` の `CODE_TABLE` の末尾に、新しい区分の行を足します。既存の行は変えず、消さず、並べ替えません。
同じ行を `tests/engine/codes.lock.json` の末尾にも足します。区分のキーは、区分番号が変わっても変えません（変わるのは点数表の `no` だけ）。

## 4. 症例・見本の UKE・練習問題を作り直す

- EM 5-1 の症例と §5-2 の合計を新しい版の値で作り直し、承認を取ります
- `config/demo.json`（診療年月・請求月・時計の初期値・データの版の印）、`config/business-days.json`（祝日）、`config/facility.json`（施設の設定）を直します
- `fixtures/cases/`・`fixtures/charts/`・`fixtures/uke/patients.json`・`fixtures/notices/` を直し、`npx tsx scripts/gen-uke.ts`・`npx tsx scripts/gen-notice.ts`・`npx tsx scripts/seed-knowledge.ts` で作り直します
- 練習問題（`src/practice/`）が、新しいルールでも「違反を探す」題材になっているかを確かめます
- すでに動いている環境のデータは、印が違う置き場の一覧を出して承認を取ってから退避します（`npx tsx scripts/reset-demo.ts --retire-stale`。消しません）

## 5. 公的情報レジストリの適用版を見直す

疑義解釈・審査の取扱いなど、要旨とリンクで持っている公的文書が、新しい版でも当てはまるかを 1 件ずつ確かめます。
レジストリが入っていない間は、EM §2-4 の表の確認日と立場を見直します。

## 6. 自動テストと、README・CLAUDE.md の固定条件を更新する

```bash
npm run typecheck && npm test && npm run check:dates && npm run build
npx tsx scripts/gen-uke.ts && git diff --exit-code fixtures/uke
```

- ルールごとの合格・不合格の最小例（`tests/engine/rules/`）、症例の合計（`tests/engine/totals.test.ts`）、版の境界（`tests/engine/revisions.test.ts`）を新しい版に合わせます
- テストの年月・日付は `tests/helpers/period.ts` から作り、直書きしません。`src`・`app`・`scripts` に年月を直書きすると `check:dates` が落ちます
- README の「守っていること」と、CLAUDE.md の固定条件（診療年月・改定年度）を直します
