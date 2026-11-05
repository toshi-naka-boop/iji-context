critic: claude/claude-opus-5-5（反証 round-16・正しさ）

## Round 16 — 2026-11-05 — 反証(正しさ)

### 指摘

- [C-61] 種別: 実装（設計の補足も必要） / 深刻度: high
  - 指摘: `reflect` が recheck を待たせるかどうかを、status_since が同じで stale でない、未反映の miss 項目すべてで判定している。そのため、議題から外れて誰も答えられない古い miss 項目が残ると、recheck の答えはずっと待たされる。`buildItems` は待っている recheck を新しく載せないので、その知識は議題から消え、要再検証のまま動けなくなる。
  - 破綻シナリオ（scratch テストで再現済み。テストファイルは削除済み）:
    1. 地域層の知識 a が要再検証のときに、請求 c-bad（提出 bad）が返戻（関係あり）になる。3/15 の会議に miss と recheck が並ぶ。
    2. (A) 責任者が recheck に 1 を答えると `held` になる。その週のうちに医療事務が返戻分を再請求する（同じ claimId で提出 bad2）と、bad は superseded になり、外れが観測から消える。3/22・3/29・4/5 の会議で `missReason` は null になり、miss は載り直さない。recheck も heldRecheck があるので載らない。議題に知識 a の項目がない状態が続き、状態は要再検証のまま、recheck の行は applied=false・stale=false のまま残った。
    3. (B) miss にも recheck にも答えないまま再請求された場合も同じになる。次の会議には recheck だけが載る（最新の議題）。責任者がそれに 1 を答えると、古い miss 項目（未回答・未反映・stale でない）が残っているので `held` が返る。以後は議題から消え、要再検証のままになる。
    - 返戻のあとの再請求は普段の業務の流れなので、よく起きる。ほかにも、別の結果が届いて今有効な結果が外れでなくなったとき、miss の snapshot だけが変わって（要再検証のまま `basisDate` が変わる。支払基金の改選日など）新しい miss 項目ができ、古い方が残ったときも同じことが起きる。
    - 地域層なら 180 日後に IDLE_EXPIRED で停止に進むが、責任者の「今も正しい」という答えは失われる。制度層や、relates_to が制度層の修正版は idle が効かないので、永久に要再検証のまま止まる。設計の「miss に答えがなければ waitingRecheck を付けて載せ直す」が成り立たないのは、載せ直す外れがもう存在しないからである。
  - 提案: 待たせる理由にする miss を、「最新の会議に載っている未回答の miss」と「回答が記録済みで未反映の miss」に絞る。整理の手順 3 では、外れがなくなって載らなくなった古い未回答の miss 項目に stale の印を付けるか、待たせる判定から外す。そのうえで、待っていた recheck を同じ整理の中で反映し直す（または recheck を議題に戻す）。§4-4 v21 の節に「待たせる元の miss が議題から消えたら待つのをやめる」と 1 行足す。回帰テストには、上の (A)・(B) と、再請求で superseded になる場合を入れる。

- [C-62] 種別: 実装 / 深刻度: mid
  - 指摘: v21 で修正版の候補（ベテラン層、relates_to が制度層・地域層）にも改定・改選のトリガーが効くようになった。しかし、照合に使う snapshot の `basisDate` は `meta.layer` だけで決まり、ベテラン層では null になる（`review.ts` の `basisDate`）。このため、「改定日をまたいで届いた recheck の回答 1 は記録だけ」というガードが修正版の候補には効かない。
  - 破綻シナリオ: 制度層 R01 から作った修正版の候補 F（ベテラン層、relates_to=R01、match.ruleId=R01）が承認済みになったあと、外れの確認の回答 2 で要再検証になる（2026-04）。2026-05-30 の会議で F の recheck が載る。責任者が 2026-06-02（偶数年の改定日 6/1 の後、次の会議の前）に 1 を答えると、snapshot はどちらも basisDate=null で一致して照合に通る。F は RECHECK_PASS で承認済みになり、status_since=6/2 になる。改定日（6/1）は status_since より前なので、①の改定トリガーはもう発火しない。改定前の前提で出た「今も正しい」がそのまま採用され、F は改定後の見直しを一度も受けずに新人のメンターへ戻る。元の制度層の知識なら basisDate が変わって stale になり、改定後の会議で確かめ直しに回るので、v21 の「元の層の改定・改選を引き継ぐ」（§4-3）と食い違う。
  - 提案: `basisDate` を `triggersOf` と同じ規則（relates_to をたどって、元の層の revision・reappointment が効くなら、その日付を入れる）で決める。改選日は、§4-3 と同じく自分の match の payer・prefecture から引く。§7 #11 の「改定日をまたいで届いた回答 1 は記録だけ」に、修正版の候補の場合を 1 本足す。

### 確認したうえで問題なしとした観点（指摘以外）
- miss 2 と recheck 1、miss 1 と recheck 1 の順序による違い：`reflect` の `misses.some(answer===2 && applied)` で stale にする処理と、miss を反映した直後に `heldRecheck` を続けて反映する処理を確認した。どちらの順で答えても結果は同じで、既存のテストとも合っている。miss 3・4 は applied=true になるので、待っていた recheck が解放されることも確認した。
- 要再検証で miss 2 → RECHECK_FAIL → 停止になったとき、disposal の candidateId は `basis.itemId`（miss 項目）から `findCandidate` で引ける。候補は relates_to が同じなら 1 件に集約される（`ensureCandidate`）。
- `triggersOf` の relates_to のたどり方（循環を防ぐ seen、元の知識がないときに break）と、machine の TRIGGER の guard（relates_to を持つ知識は idle 以外を許す）。どの層に効くかは triggers.ts が決めるので、guard の方が緩くても誤発火はしない。
