# 引き継ぎの記録：Fable → Opus（2026-11-21〜）

Claude Fable 5.2 が利用上限（2026-11-22 20:00 まで）に達したため、ここから先の作業は **Claude Opus 5.5** が行う（利用者の指示、2026-11-21）。
利用者の指示は「Fable が戻ったときに、Fable がちゃんとチェックできるようにしておいて」。この文書は、Fable（または別の見直し役）が、Opus が行ったことを漏れなく確かめるための一覧である。

## 引き継いだ時点

| もの | Fable が最後に確かめた状態 | 備考 |
|---|---|---|
| 統合ブランチ `feat/integration` | `b3ec25c`（段 13 を束ねた後） | ここまでは Fable が自分で検査を実行して束ねた |
| 文書ブランチ `docs/spec-r8` | `72626f7`（段 13 の台帳） | 設計 v24 は承認済み（指紋 v24:83fdd8181c1a） |
| 段 14 のブランチ `feat/stage14-tekio` | `02c8405`（WIP） | Fable の作業の途中。**検査を通していない**。ここから Opus が仕上げる |

境目の見分け方：
- コミットの末尾の `Co-Authored-By:` が `Claude Opus 5.5` だけのものが、Opus が書いたもの。`02c8405` は両方の名前を持つ（中身は Fable、記録は Opus）
- `git log b3ec25c..feat/integration`（統合ブランチ）と `git log 72626f7..docs/spec-r8`（文書ブランチ）が、Opus の後に入ったものの全部

## Opus が行うこと（予定。行ったら下の表に書く）

1. 段 14（G09：適応・禁忌・量と日数）を仕上げ、検査して統合ブランチに束ねる
2. v24 の実装全体の反証（正しさ・安全性・過剰実装の 3 レンズ。codex は使えれば使う）
3. 反証の指摘の修正
4. 確認用サーバーでの通しの確認（API キーあり。AI を呼ぶ操作には時間切れを付ける）

## Opus が行ったこと

| 日時 | 何を | コミット | 呼び出し側（Opus）が自分で実行した検査 | Fable に特に見てほしい点 |
|---|---|---|---|---|
| 2026-11-21 | 段 14 の途中の作業を記録としてコミット | `02c8405`（feat/stage14-tekio） | なし（記録だけ） | — |

## Fable が戻ったときの確かめ方（チェックリスト）

- [ ] 上の表のコミットを全部読む（`git log -p b3ec25c..feat/integration`）。設計書 §12 と食い違う箇所、台帳に書かれていない仮置きがないか
- [ ] 段 14 の `02c8405` 以降の差分を特に読む（Fable が書きかけた部分を Opus がどう仕上げたか。Fable が意図していたことと違う直し方をしていないか）
- [ ] 完了条件を自分で実行する：データなしで `npm run typecheck && npm test && npm run build && npm run check:dates && npm run check:banned-words && npm run check:codes && npm run check:masters`、実ファイルから `masters.db` を作り直して錨が全部通るか、データつきの `npm test`、`npx tsx scripts/measure-generic.ts fixtures/uke/*.UKE`
- [ ] G09 の指摘の文が、医学的な助言の形になっていないか（「この薬は使えません」「この病名を付けてください」と書いていないか）
- [ ] 反証のレポート（`reviews/round-32*` 以降）の指摘と、Opus の直し方が妥当か
- [ ] 台帳（`ledger.md`）の 2026-11-21 以降の行が、実際のコミットと合っているか
- [ ] `certain` の一覧（`config/generic-checks.json`）が空のままか（Opus は言い切りに上げない）
