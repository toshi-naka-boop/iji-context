# 反論台帳 — iji-context

## 未解決

（なし）

## 解決済み索引

| ID | 出所 | 種別/重大度 | タイトル | 結論 |
|---|---|---|---|---|
| C-1 | round-1 | 設計/high | 点数表が report-A だけで K2 と違反フィクスチャが作れない | v2 §2-4：出典に EM §5/§5-1 を追加、「点数未収載」区分を設けて total=null |
| C-2 | round-1 | 設計/high | idle の起点と同時発火でトリガーが遷移表と食い違う | v2 §4-3：起点を max(last_hit_at, status_since)、1 判定 1 件・優先順位 ①→②→③ |
| C-3 | round-1 | 設計/medium | HIT の入口がなく RECHECK_PASS{claim} に到達できない | v2 §4-4：適用記録と提出結果の取り込みを追加 |
| C-4 | round-1 | 設計/medium | 「起きていない」と「わからない」を区別できない | v2 §2-1：facts を三値（Fact<T>）に |
| C-5 | round-1 | 設計/medium | 日本語の層名のディレクトリ、frontmatter なし、冪等性の確認が不成立 | v2 §1・§5・§7#8：英字の layerSlug、frontmatter 生成、2 回実行の一致をテストで確認 |
| X-1 | round-1-codex | 設計/major | 状態変更後も同期先に古いコピーが残る | v2 §5：遷移直後の同期＋読み出し側での状態確認 |
| X-2 | round-1-codex | 設計/major | 制度層がヒットなしで停止する | v2 §4-2・§4-3：IDLE_EXPIRED は③が効く層のみ |
| X-3 | round-1-codex | 設計/major | match で正常通過と同じ条件を判定できない | v2 §2-2・§3：エンジンが applied を返す、match に facts 条件を追加 |
| X-4 | round-1-codex | 設計/major | 古い結果の再取り込みで再検証を解除できる | v2 §4-4：resultId で重複排除、状態と status_since が記録時と同じときだけイベント |
| X-5 | round-1-codex | 設計/major | 提案で層を自由に選べ、生成元の固定を迂回できる | v2 §4-1：生成元×層の対応表、提案は院内のみ（relates_to で対象を指す） |
| C-6 | round-2 | 設計/high | avoid 型の知識で提出結果の扱いが逆、制度ルールの対象区分が未定義 | v3 §3・§4-4：polarity と変換表、avoided→USED、各ルールに kubun 定数（未批評） |
| C-7 | round-2 | 設計/medium | 再確定のたびに適用記録が積み上がる | v3 §4-4：提出確定の版だけを記録、以前の版は superseded（未批評） |
| C-8 | round-2 | 設計/medium | 層ごとの match 必須項目が生成元・改選と噛み合わない | v3 §3：層別の必須項目表、地域は payer・prefecture 必須、ベテランは match 任意＋引用で USED（未批評） |
| C-9 | round-2 | 設計/medium | 長く続くセッションに古い Skill が残る、query_skills が院内を除かない（X-1 の再提起） | v3 §5：院内も除外、世代番号でセッション作り直し（F2 への要求）（未批評） |
| X-6 | round-2-codex | 設計/high | 修正前の適用記録で再承認できる（X-4 の対応不足） | v3 §4-4：submissions 表と superseded（C-7 と同じ対応）（未批評） |
| X-7 | round-2-codex | 設計/high | 表現できない査定知識をライフサイクルから外している（X-3 の対応不足） | v3 §3：matchApprox＋conditionNote で元の層に置く（未批評） |
| X-8 | round-2-codex | 設計/high | 査定取り込み後の再審査申出を扱えない | v3 §4-2：REEXAM_FILED（未検証・承認済み→contested）（未批評） |
| X-9 | round-2-codex | 設計/medium | 知識の版と適用記録を結びつけられない | v3 §3・§4-4：rev（内容ハッシュ）を記録し、不一致なら捨てる（未批評） |
| X-10 | round-2-codex | 設計/medium | idle による停止で廃棄提案が出ない | v3 §4-2：IDLE_EXPIRED にも廃棄提案（未批評） |

| C-11 | C-10 から派生 | 前提 | K2 に処方箋料が入っていない | ユーザー判断 (b)：F400 60 を足し K2=6,253 点。特定疾患処方管理加算は付けない（spec-input 決定56、EM #7-6 の注）。design v5 |
| C-10 | round-2 | 前提/low | 在医総管の月に処方箋料を別に算定できるか | ユーザー判断：別算定できる（report-A に合わせる、EM #7-6）。v4 §2-3 R05 に反映 |

全文は archive/ledger-resolved.md。「未批評」は、2 巡で打ち切ったため v3 の対応を批評が確かめていないことを示す。

## 経緯

- 2026-11-04 11/4 チャットUI決定で方向修正（spec-input 改訂版を正とし、spec.md を改訂版から再生成）
- 2026-11-04 批評 1 巡目（claude/claude-opus-5-5、codex/gpt-6.1-sol xhigh）。10 件すべて設計として受理し v2 で対応
- 2026-11-04 批評 2 巡目（claude/claude-opus-5-5、codex/gpt-6.1-sol xhigh）。設計 9 件を v3 で対応（3 巡目は実施しない: ユーザー指定の上限 2 巡）。前提 1 件（C-10）はユーザーに確認中
- 2026-11-04 ユーザーが v3 を承認する旨を返信。同時に C-10 の判断と取り忘れ範囲の確認があり、design.md を v4 に更新したため、承認は v4 で取り直す
- 2026-11-04 ユーザーが v4（v4:a93344817a4e）を承認。同じ返信で C-11 は (b) と指示があり、K2 の合計だけを直した v5 に承認を適用（state.json の approvalNote）
