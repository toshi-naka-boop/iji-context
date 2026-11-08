critic: claude/claude-opus-5-5（反証 round-13・正しさ）

## Round 13 — 2026-11-05 — 反証(正しさ)

対象: design.md v17 の §3（Basis.asOf・時刻の形式）・§4-4・§7 #5・#11。実装は src/lifecycle/review.ts（movableOf・judge・acknowledged・snapshotOf・reportReason・reflect）・store.ts・time.ts。
high の疑いは scratch テスト（tests/lifecycle/ に一時ファイルを置いて実行し、実行後に削除）で再現を確かめた。リポジトリのファイルは変えていない。

### 指摘

- [C-57] 種別: 設計 / 深刻度: high
  - 指摘: v17 は「ベテランは asOf（項目を載せた整理）の時点で届いていた結果を見て答えている」という前提で、回答で入った状態の「動かせる提出」を `asOf < importedAt` に絞っている。しかしまとめには、asOf より前に届いていても一度も載らない外れがある。その外れは回答の後、状態も動かさず、「回答の後の外れ」にも載らない。C-55 と同じ「関係ありの査定が黙って捨てられる」が別の経路で残っている。
  - 破綻シナリオ（どちらも scratch テストで再現。地域層・allow・kubunAll=[C001]）:
    1. **要再検証の間に届いた、入る前の提出の外れ**：3/5 に bad、3/6 に S を提出。3/10 に bad の査定（C001）が届く → 3/12 の整理で要再検証（status_since=3/12）。3/18 に S の査定（C001）が届く。S は要再検証に入る前の提出なので動かせない（`status_since < submittedAt` を満たさない）。3/20 のまとめの recheck の理由は `{event: COUNTER_EXAMPLE, submissionIds:["bad"]}` だけで、S は出てこない。3/22 に回答 1 で承認済み（asOf=3/20）。S の importedAt は 3/18 で asOf より前なので fresh でない。3/27 の整理では承認済みのまま、まとめは空、misses=2。S の外れは誰にも見せないまま閉じる。結果が月単位で遅れて届く以上、これは毎月ふつうに起きる。
    2. **「回答の後の外れ」が未回答のうちにトリガーが来る**：支払基金の地域知識。3/22 の recheck 回答 1 で承認済み（asOf=3/20）。5/25 に S（3/15 提出）の査定が届き、5/29 のまとめに「回答の後の外れ」S が載る。ベテランは答えない。6/5 の整理で改選トリガーにより要再検証になる（byAnswer の外れは手順 1 で動かさないので、COUNTER_EXAMPLE のように `basis` に外れが残らない）。6/5 の recheck の理由は `{event: TRIGGER{reappointment}}` だけで S は消える。6/6 に回答 1（改選後も変わらない）で承認済み（asOf=6/5）。S の importedAt 5/25 < 6/5 なので、6/19 の時点でも承認済みのまま、まとめは空。案 D で「機械はベテランの判断を黙って打ち消さない」としたのに、ここではベテランが見ていない外れを機械が黙って捨てる。回答が絡まない承認済みの知識なら、同じ外れは手順 1 で COUNTER_EXAMPLE になり、トリガーも basis に残る（C-48・§7 #5 (q)）ので、回答が絡んだときだけ情報が落ちる。
    3. （静的読解）停止の間に届いた外れも同じ形になる。disposal の理由は停止に入ったときの basis だけなので、停止中に届いた外れは載らず、DISPOSAL_REJECT（asOf=項目の整理）の後は fresh でなくなる。
  - 提案: 基準を「時刻」ではなく「ベテランに見せたかどうか」にする。案 a：回答で入った状態では、動かせる外れを「回答した項目の理由に載っていなかった（提出×resultId）のうち、確認済みでないもの」とする（時刻を見ない）。案 b：asOf 方式のまま、recheck・disposal の理由と snapshot に「今の rev で、まだ状態に効いていない外れ（提出×resultId）」をすべて載せ、見せたものだけを asOf の対象にする。案 b を選ぶ場合、シナリオ 2 では、byAnswer で手順 1 に残っている外れを、トリガーの遷移の basis にも残す（C-48 の逆向き）必要がある。§7 #5 に上の 1・2 を足す。

- [C-58] 種別: 設計 / 深刻度: mid
  - 指摘: `asOf < importedAt` は時刻が同じだと順序を区別できない。整理と同じ時刻に、整理の後で取り込んだ結果が、回答の後でも永久に fresh にならない。
  - 破綻シナリオ（scratch テストで再現）：デモは「時計を進める」操作で整理を回す（§4-4）。時計を 3/20 に進めて整理を回し、その時計のまま recheck に回答 1 を出し、続けて S（3/15 提出）の査定を JSON から取り込む。importResult の now もデモの時計なら importedAt=3/20=asOf になる。3/27 の整理では承認済みのまま、「回答の後の外れ」は載らない。§7 #5 (t) のデモ版がそのまま壊れる。`<` を `<=` に変えるだけでは直らない。同じ時刻に整理の前に取り込んで、その整理で扱い済みの結果が、今度は二重に出てくる。同じ時刻のとき、整理の前に取り込んだのか後に取り込んだのかは、時刻だけでは決められない。
  - 提案: `claim_results.seq`（すでに単調増加で、effectiveResult の並べ替えに使っている）を基準にする。整理の開始時に `reviews.maxResultSeq` を記録し、`basis` には asOf と並べて「項目を載せた整理の maxResultSeq」を残す。比較は `seq > basis.asOfSeq` で行う。C-57 で案 a を採るなら、この指摘はなくなる。

### 確認して問題なしとした点（参考）
- 回答で入った要再検証に RECHECK_PASS{claim} を出さない処理（judge の `answered` で早く抜ける）は、すぐ反映でも拾い直しでも同じ整理のうちに戻らない。§7 #5 (u) のテストの経路も読んだ。
- 確認済みを（提出×resultId）で持つ処理：resultId は一意で、importResult は再送を重複として捨て、同じ内容でも採用し直すときは新しい id になる。このため、確認済みの組が新しい結果を誤って隠すことはない。照合の snapshot に submissionIds・kubun・results が入るので、区分の訂正や外れの追加があれば古い項目は stale になる。
- USED は history を積まない（machine.ts で `to === status` のとき push しない）ので、`ignored` 1 や avoided の USED が「最後の history」を上書きして `answered` を誤って false にすることはない。
- basis.asOf は store の入口で形式を確かめている（X-51）。asOf のない古い history は `status_since < submittedAt` に戻るので、ここで例外にはならない。
