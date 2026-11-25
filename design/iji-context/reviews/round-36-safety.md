委譲先: Claude Code サブエージェント（直接実行。外部 CLI への委譲なし） / モデル: claude/claude-opus-5-5

## Round 36 — 2026-11-21 — 反証(安全性・作りすぎ)

対象：`git diff feat/integration..feat/stage-15a`（6 コミット）。設計は本体の design.md §13（v25）。
実測：scratchpad に置いたテスト（`/private/tmp/claude-501/-Users-toshixa-Documents-iji-context/2b55f9e0-1fbd-45be-a64c-446b804ed7ab/scratchpad/t/probe.test.ts`。routes-haihan-answers.test.ts の準備をそのまま使い、worktree のファイルは変えていない）で C-141〜C-143 を再現した。

### 指摘

- [C-140] レンズ: 安全性 / 種別: 実装 / 深刻度: mid / PLAUSIBLE（今の config では起きない。守りがないことは CONFIRMED）
  - 指摘: 共有の事実を使う問いの答えを書くとき、`saveClaimFact` は共有の事実の側（`sharedOf(f.key)`）を、`validateClaimFact`（値の型・日付）と宛先の確認（`targetOf`）を通さずに書く。config のテストは `factKey` に `CLAIM_FACT_KEYS` のどれでも許すので、この抜け道を止めるものがない。
  - 破綻シナリオ: 15b で例外を足すとき、`ask.factKey` に医師あての事実（例 `rxLongPsychotropic`〔日ごと・医師あて〕、`deathPlace`〔医師あて・値は在宅/在宅以外〕）を入れる。テスト（haihan-config.test.ts「key は、既存の事実か haihan:<HX-nn>」）は通る。事務の役割が `haihan:HX-nn:…` に「はい」を送ると、宛先は `targetOf(haihan:*)＝clerk` なので通り、`insert(shared, f.date, true)` が医師あての事実を事務の名前で書く（医師確認の UI 要件の迂回）。`deathPlace` なら真偽値 `true` が入り、`Check.fact` の `String(f.value)`＝"true" は ok にないので「当たらない」になる。`scope: "claim"` の共有の問いなら、日ごとの事実に date="" の行が入る。
  - 提案: (1) config のテストで、共有の factKey を「日ごとの事実（DATED_FACT_KEYS）かつ医療事務あて、かつ scope=day」に縛る（今は `sameDayOushinAfterVisit` だけ）。(2) `saveClaimFact` の共有側の書き込みも `validateClaimFact`・`targetOf` を通す。

- [C-141] レンズ: 安全性 / 種別: 実装 / 深刻度: low / CONFIRMED
  - 指摘: 取り消しの印 `"__cleared__"` を利用者の入力と区別していない。文字の事実（`mainDisease`）に利用者が `__cleared__` と入れると、取り消しとして読まれる。
  - 破綻シナリオ（実測）: 医師の役割で `mainDisease="高血圧症"` → `mainDisease="__cleared__"` を POST すると 200。一覧（GET）は `[]` になり、`applyClaimFacts` は主病を `known:false` にする（R 系は主病を不明として扱う）。監査ログの対象は `U1-1 mainDisease` だけで、値が取り消しの印だったことは残らない。入力の検査（主病は 1〜N 文字）は通っている。
  - 提案: `validateClaimFact` で `value === CLEARED` を拒む（または印を文字列でなく JSON の別の形〔例 `{"cleared":true}`〕で持つ）。

- [C-142] レンズ: 安全性 / 種別: 実装 / 深刻度: low / CONFIRMED
  - 指摘: R10 の入力で `sameDayOushinAfterVisit` を直接書いたときに、同じ日の `haihan:*` を取り消す行を足しているが、監査ログの対象には共有の事実の key しか入らない（§13-3「どちらも監査ログに残す」）。あわせて、この分岐のコメント「残っていても効かない」は誤り。
  - 破綻シナリオ（実測）: 事務が HX-01 に「その他」（5 日）→ R10 の入力で `sameDayOushinAfterVisit=true`（5 日）。claim_facts には `haihan:HX-01:114000110:114001110 = "__cleared__"` が足されるが、監査ログは `U1-1 sameDayOushinAfterVisit` だけ。取り消した答えの key が監査ログから辿れない。また、`false` を直接書いた場合は `sameDayOf` が `need: sameDaySeparate` を返すので、`haihan:*` の「その他」が残っていれば G05 は「決まらない」で問いを止め、取り消せば別々の診療かを問い直す。つまりこの取り消しは判定を変える（コメントを信じてこの分岐を消すと、問い直しが止まる）。
  - 提案: 監査ログの対象に、取り消した `haihan:*` の key を足す（route 側で取り出せないなら、`saveClaimFact` の戻りに取り消した key を返して audit に渡す）。コメントを「答えを変えれば問い直す（§13-2 の 4）ために取り消す」に直す。

- [C-143] レンズ: 安全性 / 種別: 実装 / 深刻度: low / CONFIRMED
  - 指摘: `haihan:<HX>:<コード①>:<コード②>` のコードを、その例外の組（HP の a・b）とも、その請求の行とも照らしていない（形と小さい順だけを確かめる）。
  - 破綻シナリオ（実測）: 事務が `haihan:HX-01:111111111:222222222`（実在しない・請求にないコード）に「はい」を 20 日（請求に往診も訪問診療もない日）で POST すると 200 で、`sameDayOushinAfterVisit=true`（20 日）が書かれる。共有でない例外なら、どこからも読まれない答えが「確かめた：特例の例外の問い（HX-nn・コード 111111111 と 222222222）」として一覧に残る。権限は上がらない（事務は R10 の入力で同じ事実を書ける）ので low。
  - 提案: 例外の id から組を引き、コードがどれかの組（その例外を含む）の a・b に当たり、かつ請求の行にあることを確かめる。重いなら、少なくとも請求にあるコードかだけを確かめる。

### 作りすぎ（指摘にしなかったものと根拠）

- 型に `text` を足した：§13-1 は EM の行に「一言の条件」を持たせ、§13-2 の文は「例外〔一言〕」を求めている。`text` はそれを運ぶだけで、haihan-config.test.ts が EM の 1 列目と一致を縛っている。原文の引用（15 字）は config に持たず、画面にも出ない。妥当。
- `G05.exception_split` を足した：§13-2 は「日によって分かれたら『決まらない』として、分かれた日を文に挙げる」と求めるが、既存の文に日を挙げるものがない。新しい messageKey は文の置き場であって機能の追加ではない。妥当。ただし、ほかの例外に未決の問いがあると split の日は文に出ない（exception_ask が優先）。設計の要求の取りこぼしとしては正しさのレンズの論点で、ここでは挙げない。
- 答えを渡さない経路で問いを出さない：§13-2（月末の点検・算定プレビュー・measure-generic は answers を渡さない）と L-76（15a では取り込んだレセプトの点検だけで問いを出す）に沿う。問いを出さないときは今までの `G05.*_cond` に落ちるので、黙って消えない。試算（uke-check の trial）も exceptions を渡さず、画面も `answer` を渡さない。妥当。
- そのほか：`makeG05(config)`（テストで決まりを差し替える）と `silenced` の集計（§13-2 の 2「点検の範囲に n 件と id」）は設計にトレースできる。route.ts と claim-facts.ts に `sharedOf` が二重にあるのは重複だが、好みの範囲なので挙げない。

### 確認して問題なしとした安全性の観点

- 権限：`haihan:*` の宛先は `targetOf`＝医療事務で、医師の役割は 403（既存テストと読みで確認）。ルートの役割表（policy.ts）は変えていない。
- 入力の検査：zod で `^haihan:HX-\d{2}:\d{9}:\d{9}$`、`parseHaihanKey` で小さい順、`isHaihanFactKey` で問いのある例外、`validateClaimFact` で選択肢の文字列と日付（scope=day は診療年月の日付、claim は null）。key に任意の文字は入らない。
- 監査ログ：対象は請求 id と key（と共有の事実の名前）だけ。値・患者の識別子は入らない（実測の audit_log の target で確認）。
- 画面：問いの文・選択肢・一言の条件・コード・日付だけ。患者名・公開元の原文は出ない。
- 問いの文：config の 15 問すべてに「その他」「判定不能」（means=決まらない）があり、`点数|金額|点|円` を含まない（スクリプトで確認、テストでも縛っている）。
- 取り消しの読み手：claim_facts を読むのは claim-facts.ts だけ（ほかは erase.ts の削除のみ）。`withClaimFacts` は取り消しを含む最新行を `applyClaimFacts` に渡し、一覧と answers は取り消しを除く。`sameDaySeparate` など日ごとの事実は、取り消しの日を消して不明に戻す。誤読は C-141 の入力の衝突だけ。
- tenant の分離：claim_facts は tenant ごとの app.db（`tenantPaths(tenantId).dbFile`）にあり、今回の変更は既存のルート・接続の中だけ。
