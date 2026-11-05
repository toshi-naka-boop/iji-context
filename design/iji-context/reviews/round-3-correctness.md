model: claude-opus-5-5（Claude Code サブエージェント）
## Round 3 — 2026-11-04 — 反証(正しさ)

範囲: design.md §4-4 と、そこから使う §4-2・§4-3、§3 の match／polarity。実装は src/lifecycle/applications.ts・match.ts・machine.ts・store.ts、src/db/schema.ts、tests/lifecycle/applications.test.ts、src/engine/index.ts の ruleKubun。
再現: tsx のスクリプトを scratchpad に置き、リポジトリの実装を直接 import して実行した（リポジトリ内のファイルは変更していない）。結果は各指摘に書いた。

### 指摘

- [C-13] 種別: 設計 / 深刻度: mid
  - 指摘: 重複を resultId だけで判定しているため、1 つの提出（submissionId）に別の resultId の結果が何件来ても、そのたびにイベントが出る。承認済みでの HIT・COUNTER_EXAMPLE・USED は status_since を変えないので、§4-4 手順 3 の照合でも止まらない。
  - 破綻シナリオ（実測）: 承認済み・allow・kubunAll=[C001] の知識で s1 を確定する。s1 の結果を r1「通過」、r2「通過」（同じ結果 JSON を resultId を振り直して再出力したもの）、r3「査定 [C001]」の順に取り込む。
    - 期待: 1 提出につきイベントは 1 回。少なくとも同じ提出から HIT と COUNTER_EXAMPLE が両方出ることはない
    - 実際: `r1 [HIT] hits 1` → `r2 [HIT] hits 2` → `r3 [COUNTER_EXAMPLE] hits 2 misses 1`。同じ請求 1 件で 2 回当たり、同時に反例にもなる
    - 要再検証の知識では、最初のイベント（RECHECK_PASS／COUNTER_EXAMPLE）で状態が変わるので 2 件目以降は捨てられる。重複して数えられるのは承認済みだけになり、扱いが状態によって変わる
  - 提案: 1 提出から出すイベントを 1 回に限る（例: claim_results の submissionId に一意制約を付け、2 件目は取り込み済みとして扱う）。または「査定は通過より後に来れば上書きする」など、同じ提出に複数の結果が来るときの規則を §4-4 に書く。どちらが正しいかは業務の流れ（1 請求に結果が何回来うるか）によるので、決まらなければ前提としてユーザーに確認する。テストはこの分岐を確かめていない。

- [C-14] 種別: 実装 / 深刻度: mid
  - 指摘: importResult は、イベントを計算する前に claim_results に書き込む（applications.ts 103–111 行）。その後で ruleKubun や getKnowledge が例外を出すと、結果は取り込み済みとして残り、やり直しても `duplicate: true` でイベントが出ない。結果は失われる。
  - 破綻シナリオ（実測）: 制度層の知識 `match.ruleId="R99"`（エンジンの RULES から外れたルール。ルールの改名・削除で起こる）を s1 で記録し、返戻 [C001] を r1 として取り込む。
    - 1 回目: `未知のルール: R99` の例外が出る（エンジンの ruleKubun が投げる）
    - 2 回目（同じ r1）: `{"duplicate":true,"events":[]}`。同じ提出に紐づくほかの知識のイベントも出ない
    - 同じ理由で、importResult がイベントを返した後、呼び出し側が applyEvent で反映し終える前に落ちた場合も、取り込みのやり直しができない（知識はファイル、結果は SQLite にあり、まとめて書けない）
  - 提案: 少なくとも、イベントを計算し終えてから claim_results に書く（計算が例外ならやり直せる）。知識が見つからない・ルールがない場合は、その知識だけ飛ばす。呼び出し側が反映し終えた時点で「反映済み」とする列を分けるかどうかは設計で判断する。

- [C-15] 種別: 設計 / 深刻度: mid
  - 指摘: §4-4 の変換表には「返戻・査定（関係なし）」の行がない。そのため、査定で別の区分だけが削られた請求では、avoid の知識が予告した項目は通ったのに何も起きない。実装はこの場合を null（イベントなし）にしている。
  - 破綻シナリオ（実測）: avoid・kubunAll=[C001]（「C001 があると査定される」）の承認済み知識が final で当たり、本人が警告を無視して提出した。結果は「査定 kubun=[Z999]」。C001 は削られていない。
    - 期待: 査定は請求の一部だけを削り、残りは認めるので、C001 は通ったことになる。「通過」と同じく COUNTER_EXAMPLE になるべき
    - 実際: `{"duplicate":false,"events":[]}`。外れた予告が数えられないので、要再検証の avoid 知識は反例で停止せず、idle を待つことになる
    - 逆も同じで、allow の知識が査定（関係なし）では HIT にならない。返戻（関係なし）は請求全体が戻るので「判定できない（null）」で正しいが、査定はそうではない
  - 提案: 変換表に「査定（関係なし）」の行を足す（allow→通過と同じ、avoid→通過と同じ）。返戻（関係なし）を null にすることも明記する。テストは返戻（関係なし）しか確かめておらず、査定（関係なし）がない。

- [C-16] 種別: 設計 / 深刻度: low
  - 指摘: avoided→USED を polarity によらずに出すため、allow の知識で本人が助言に従わずに外した場合も「使われた」として扱われる。要再検証のまま、idle で停止しない。
  - 破綻シナリオ: 地域層・allow の知識 K（「支払基金・東京都では X と Y を併せて算定できる」。要再検証）について、本人は毎月 X+Y で評価して K が当たるが、確定前に Y を外す（K を信じていない）。avoided として記録され、毎月 USED で last_hit_at が更新される。その結果 `max(last_hit_at, status_since)` から 180 日が経たず、IDLE_EXPIRED が出ないので、誰も従わない知識が要再検証のまま残る。avoid の「助言どおりに直した」と、allow の「助言を捨てた」が同じ扱いになる
  - 提案: avoided→USED を avoid の知識に限る。allow で avoided のときはイベントを出さない。avoided×allow をテストで確かめていない。

- [C-17] 種別: 実装 / 深刻度: low
  - 指摘: 「関係あり」の判定基準を、設計は層で決める（制度層は ruleKubun）が、実装は `match.ruleId` があるかどうかで決める。store の validate は、制度層以外が ruleId を持つことを拒まないので、両者が食い違う。
  - 破綻シナリオ（実測）: 院内層・allow・`match={ruleId:"R01", kubunAll:["C001"]}` の知識を s1 で final に記録し、返戻 [C001] を取り込む。設計では院内層は kubunAll と照合するので関係あり → COUNTER_EXAMPLE になるはず。実装は ruleKubun("R01")（`C002_2I1, C002_2RO1, ...`）と照合するので関係なし → `events: []`
  - 提案: 判定の分岐を `meta.layer === "制度"` にそろえる。または validate で、制度層以外の ruleId を拒む。どちらにするかを §3 に一文で書く。

### テストが確かめていない分岐（指摘とは別の参考情報）
- 同じ submissionId に別の resultId で 2 件取り込む場合（C-13）
- 要再検証で RECHECK_PASS／COUNTER_EXAMPLE が出た後、同じ提出の後続の結果が捨てられること
- 要再検証の COUNTER_EXAMPLE を取り込んだときに停止へ移り、廃棄提案（DISPOSAL_PROPOSAL）が出ること（machine 単体では確かめているが、取り込みからの経路では確かめていない）
- 結果を取り込んだ後に同じ claimId を確定し直した（superseded になった）場合。取り込み済みのイベントは取り消されない（これは設計どおりだと読んだ）
- 査定（関係なし）（C-15）、avoided×allow（C-16）、matchApprox の知識が avoided として記録されたとき USED も出ないこと（§3 の「状態を動かすのは引用とベテランだけ」と実装は合っている）
