critic: claude/claude-opus-5-5（反証 round-11・正しさ）

## Round 11 — 2026-11-05 — 反証(正しさ)

対象: design.md §4-2・§4-3・§4-4（v15）、src/lifecycle/{review,applications,machine,store,match}.ts、src/db/schema.ts。
既存テスト `npx vitest run tests/lifecycle` は通る。下記 C-50〜C-53 は一時テスト（tests/lifecycle/tmp-r11.test.ts。実行後に削除済み）で再現した。C-54 は静的読解による。

### 指摘

- [C-50] 種別: 設計 / 深刻度: mid（high 寄り）
  - 指摘: ベテランの回答で状態が変わると `status_since` が回答時刻に進むため、その週にまだ判定していない外れ（要再検証に入った後の提出）が、どの整理でも動かせなくなって消える。
  - 破綻シナリオ（実測 A）: 地域層 K（承認済み）。s1 を 03-05 に提出し、03-10 に査定（C001）。03-20 の整理で K は要再検証になり、recheck 項目が出る。s2 を 03-21 に提出し、03-25 に査定（C001）が届く。これは要再検証で 2 回目の外れなので、本来は停止になって廃棄提案が出る。ところが 03-26 にベテランが（s1 だけを見て）recheck に 1 と答えると、`RECHECK_PASS{veteran}` で status_since=03-26 になる。03-27 と 04-03 の整理では s2.submittedAt(03-21) < status_since(03-26) なので s2 は動かせる提出に入らず、**K は承認済みのまま**（misses=2 と数えるだけ）。DISPOSAL_REJECT でも同じことが起きる。手順 0 の拾い直しで反映した場合は status_since=now になるため、同じ整理の手順 1 でその週の外れがすべて落ちる。v13 までは即時反映だったので、この外れは 03-25 に停止を起こしていた。v14 の「遅れは最長 1 週間」という前提が、遅れではなく「消える」に変わっている。
  - 該当: review.ts 204-208（`t(meta.status_since) < t(o.submittedAt)`）、design §4-4 手順 1 の 2 つ目の条件、手順 0。
  - 最小の修正案: 回答による遷移（basis.itemId を持つ history）の場合は、比べる起点を `status_since` ではなく、その項目を作った整理の ranAt（＝ベテランが見た情報の時点）にする。つまり、`max(直前の結果・トリガーによる遷移の at, 項目の snapshot の作成時点)` より後の提出は、回答の後でも動かせるようにする。もう一つの案として、手順 0 で反映する回答も含め、回答の反映は「その週の手順 1 の後」に回す（ただし C-47 の「直す必要がある」が通過で上書きされない、という要件と両立させる必要がある）。

- [C-51] 種別: 設計 / 深刻度: mid
  - 指摘: 同じ知識に recheck（または disposal）項目と ignored 項目が同時に載ると、先に recheck/disposal に答えて状態が変わった時点で、ignored 項目の snapshot（status・status_since を含む）が合わなくなり、ignored の回答が必ず stale になる。
  - 破綻シナリオ（実測 B）: K（承認済み）。s1 を 03-05 に提出して査定（C001）。s3 を 03-06 に提出し、C001 を外す（ignored）。03-20 の整理で recheck(K) と ignored(s3×K) が同じまとめに載る。ベテランが 03-21 に recheck に 1、続けて ignored に 2（足りない条件「X」）と答えると、戻り値は `{"status":"stale"}`。候補は 0 件、外れにも数えず（misses=1 のまま）、(s3×K) は閉じない。翌週も同じ問いがまた載るため、ベテランは同じ回答を 2 回させられる。答える順番が逆なら両方とも反映されるので、結果が回答の順序に依存する。ignored の回答の効果（USED・候補作成・閉じる）は、知識の status と関係なく意味を持つのに、照合に status を使っている。
  - 該当: review.ts 253-256（snapshotOf を種類を問わず共通に使っている）、505・358-364。design §4-4「回答の反映」手順 3。
  - 最小の修正案: ignored 項目の snapshot は rev と basisDate だけにする（status・status_since を外す）。USED は「今の状態が許すとき」というガードがすでにあるので、それで足りる。

- [C-52] 種別: 前提 / 深刻度: mid
  - 指摘: 時刻の形式（日付だけか、時刻付きか、タイムゾーンの扱い）が決まっていない。日付だけの形式（テストとデモの既定）では、`status_since < submittedAt` が厳密な比較なので、状態が変わった日と同じ日に出された提出の外れは、その状態のあいだ永久に動かせない。
  - 破綻シナリオ（実測 C）: K を 03-10 に承認する。s1 も 03-10 に提出し、03-15 に査定（C001）。03-20 の整理の後も K は承認済みのまま（misses=1）。整理を回した日（status_since=now）に提出された請求も同じく落ちる。デモの「時計を進める」で整理日とその日の提出が重なると、毎回この状態になる。
  - 破綻シナリオ（実測 D、混在）: TZ=Asia/Tokyo で、K を "2025-03-10" に承認し、s1 を "2025-03-10T08:00:00"（タイムゾーンなし）で提出する。`Date.parse` は前者を UTC 0 時、後者を JST の現地時刻（UTC では 03-09 23:00）として解釈するので、提出が承認より前と判定され、K は承認済みのまま動かない。改定日・改選日は calendar.ts で `${y}-06-01`（UTC 0 時）として作られるので、地域層の `t(submittedAt) >= t(rp)`（review.ts 237）と §4-3 の `isAfter` でも、JST の 06-01 0:00〜8:59 に出された提出や状態変化が改選前として扱われる。`reviewId = review-${now}` と `orderBy(ranAt)` は文字列のまま比べているので、形式が混ざると最新の整理を取り違える。
  - 該当: review.ts 29-33・206-207・237・150・406、calendar.ts 14-23・31。呼び出し側（API Route）が未実装なので、どの形式で `now` が入ってくるかが決まっていない。
  - 最小の修正案: §4-4 に「時刻はすべて UTC の ISO 8601 で、ミリ秒まで持つ（`toISOString()`）」と決め、`t()` で `Z` または `±hh:mm` のない時刻付き文字列を例外にする。日付だけの文字列は calendar の改定日・改選日のみに認め、`T00:00:00+09:00` を付けて JST 0 時として比べる。

- [C-53] 種別: 実装 / 深刻度: mid
  - 指摘: 修正版の候補を作っている途中で止まる（ディレクトリと SKILL.md は書いたが、meta.json を書く前）と、拾い直しが毎回 `既に存在する知識` で例外になる。手順 0 は例外を捕まえないので、以後の整理は手順 1〜4 に一度も進まない。
  - 破綻シナリオ: recheck に 2 と答える → `RECHECK_FAIL`（停止。history に itemId が残る）→ ensureCandidate → createKnowledge が mkdir し、SKILL.md（marker 入り）を書いたところで止まる。次の整理の手順 0 で reflect が `transitioned=true` と判定して ensureCandidate を呼ぶ。findCandidate は listKnowledge で探すが、meta.json のないディレクトリは飛ばされるので見つからない。もう一度 createKnowledge を呼ぶと、同じ slug `fix-<itemId 12 桁>` で existsSync が true になり例外になる。同じ例外が毎週繰り返され、結果による判定・トリガー・まとめがすべて止まる。「途中で止まっても、もう一度回せばよい」（§4-4）が成り立たない。
  - 該当: store.ts 104-136（mkdir → SKILL.md → meta.json の順。存在チェックはディレクトリで行う）、review.ts 474-486・161-164。
  - 最小の修正案: createKnowledge で meta.json を先に一時名で書くか、`existsSync(meta.json)` で存在を判定し、meta のないディレクトリは上書きして作り直す。あわせて、手順 0 は項目ごとに try/catch で囲み、失敗した項目を残したまま手順 1 以降へ進めることを §4-4 に書く。

- [C-54] 種別: 設計 / 深刻度: low
  - 指摘: ignored の回答 2 で、候補を作った後、`applied=true` を書く前に止まると、拾い直しの時点で snapshot が変わっていれば stale になる。候補は残るが、外れとしては数えず、(提出×知識) も閉じない。途中経過は history の itemId でしか見ておらず、遷移を伴わない ignored には候補の marker による判定がない。
  - 破綻シナリオ: 03-21 に ignored(s3×K) に 2 と答え、候補を作った直後に止まる。同じ週に（C-51 と同じく）recheck の回答で K の status_since が変わる。または 06-01 の改定・改選をまたぐ。次の整理の手順 0 で snapshot が合わず stale になる。候補 fix-… は「どの項目からも参照されない未検証の候補」として残り、翌週また同じ ignored が問われる。2 回目の回答 2 はその候補に書き足されるので重複はしないが、1 回目の回答は外れに数えられない。
  - 該当: review.ts 502-510・526。design §4-4「回答の反映」手順 2。
  - 最小の修正案: 手順 2 の「途中まで反映済み」の判定に、「findCandidate(元の知識, itemId) が見つかる」を加える（ignored 2・recheck 2 の両方）。C-51 の修正を入れれば、この経路はほとんど起きなくなる。

### 問題なしと確認した観点（参考）
- 同じ now での再実行: reviewId と itemId が now から決まり、`onConflictDoNothing` と使い回しで項目は増えない。手順 1・3 で動いた知識は status_since=now になり、厳密な `<` のおかげで同じ判定は二度通らない（ただし C-52 の同日問題の裏返し）。
- RECHECK_PASS{claim} の根拠の例外: `history.at(-1)` は状態が変わるときしか積まれないので、`last.to === meta.status` は常に成り立つ。外れで 1 回動けば最後のイベントが COUNTER_EXAMPLE に変わり、例外は閉じる。
- 数え直し: hits と misses は rev が一致する観測から毎回作り直しており、足し引きはしない。last_hit_at は `last_used_at` と当たりの importedAt の max で、touchUsed とも矛盾しない。手順 2 は手順 3 より前にある。
- 項目 id の使い回し: 未回答で（種類・知識・提出・snapshot）が一致するものだけを使い回している。回答済み・stale の項目は使い回さない。
