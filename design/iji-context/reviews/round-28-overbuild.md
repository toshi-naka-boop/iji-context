批評役: design-critic（claude / claude-opus-5-5）。レンズ: 過剰実装と、設計との食い違い

## Round 28 — 2026-11-20 — 反証(過剰実装・設計との食い違い)

対象: `.claude/worktrees/integration`（feat/integration、HEAD 2320971）の `8aa200a..HEAD`。設計 design.md §11（v23:7428610f1a42）、台帳 2026-11-20 の行。
実測は grep（git grep）だけで行った。テストの書き換えはしていない（下の指摘は、どれも静的に確定できたため）。

### 指摘

- [O-11] 種別: 実装 / 深刻度: mid
  - 指摘: CLAUDE.md が 2 本に割れている。worktree の版は同じ「固定条件」の中で矛盾しており、main（docs/spec-r8）の版には v23 で覆した 4 行が残っている。
  - 該当: `.claude/worktrees/integration/CLAUDE.md` 13 行「合成レセプトの診療年月は 2025年3月、点数は 2024年度改定後」と、その直後の 14 行（1afc271 で追加）「請求の判定に使う版は令和8年度改定後のものだけ」。同じファイルの 4・10 行は「spec-input が正」、16 行は「K1〜K6」のまま（config/demo.json は 2026-10、症例は K7 まである）。`/Users/toshixa/Documents/iji-context/CLAUDE.md` には「レセ電コードは架空。READMEに『架空コード』と明記する」「アップロードと連携で受け入れるのは架空コードだけで作られた合成データに限り、実機の電子カルテ・レセコンには接続しない」「2024年度版は持たない」が残っている。台帳 219 行には「3 行書き替え」とだけあり、書き替えたのが worktree の 1 本だけであることは書かれていない。
  - 破綻シナリオ: (1) docs/spec-r8 の作業ツリーで起動したエージェント（この反証の呼び出しもそう）は、「レセ電コードは架空」「2024年度版は持たない」を固定条件として受け取る。すると `r2026-codes.ts` の実在コードや `r2024.ts` を固定条件違反と判定し、戻す修正を提案できてしまう。(2) feat/integration 側で動く段のエージェントは「診療年月 2025年3月・2024年度改定後」を読み、診療年月を直書きしてしまう。(3) 2 つのブランチは scaffold（3a7da13）から分かれた後、どちらも同じ節を別々に書き換えている。main に入れるときに衝突し、どちらを取っても実装と合わない行が残る。
  - 提案: main の CLAUDE.md に、worktree で足した v23 の 3 行（版・実在コード・実在データ）を移し、古い 4 行を消す。worktree の古い行（2025年3月・spec-input・K1〜K6）は main の文に揃える。そのうえで台帳に「正の CLAUDE.md はどちらか」を 1 行書く。

- [O-12] 種別: 実装 / 深刻度: low
  - 指摘: `outboundForBundled` は本番のコードから 1 度も呼ばれていない。呼んでいるのはテストだけで、同意の確認を飛ばすために使っている。さらに `docs/security.md` は、評価のスクリプトがこれを使うと事実と違う説明をしている。
  - 該当: `src/llm/outbound.ts` 19〜30・37 行（`BUNDLED` なら無条件で通す分岐）。呼び出しは `tests/chart/image.test.ts:22`・`tests/voice/kana.test.ts:22`・`tests/llm/outbound.test.ts:240` だけ。`eval/run-eval.ts` の `runEval(root, opts, by: Sender)` は、`app/api/eval/route.ts:18` からログインした `user` を受け取っている。種のスクリプト（`scripts/seed-knowledge.ts`）は AI を呼ばない。`docs/security.md:48` は「利用者のいない呼び出し（種・評価のスクリプト）は `outboundForBundled` を使い」と書いている。`tests/llm/outbound.test.ts:44` の「app/ と src/server/ から読み込まない」は、呼び手が 0 なので常に通る。
  - 破綻シナリオ: 保守者は security.md を読み、評価は同意なしで同梱データだけを送ると理解する。実際は開発者本人の同意が要り、同意していなければ `/api/eval` が 403 になって原因が分からない。また本番の出口に、使い道のない無条件の素通りが残る。禁止の範囲は app/・src/server/ だけなので、src/chart/・src/mentor/・src/notice/ のどれかがこれを渡すように変わっても、テストは落ちない。この 3 か所は利用者の入力を送る側である。
  - 提案: 呼び手がいないので、`outboundForBundled` と `BUNDLED` の分岐を消す。テストは既にある `tests/helpers/consent.ts` の同意済みの利用者で送る。設計 §11-11 の入口を残すなら、security.md:48 を「いまは呼び手なし」に直す。

- [O-13] 種別: 実装 / 深刻度: low
  - 指摘: カルテの算定プレビューは、版の選択肢を取るためだけに改定の比較の API を呼んでいる。版の一覧の作り方は 3 か所に分かれている。
  - 該当: `app/chart/claim-preview.tsx:36` が `fetch("/api/revision/compare")` を呼び、`revisions` だけを使う。失敗は `.catch(() => {})` で捨てている。`src/server/app/revision.ts:20` の `compareOf` は、引数なしで呼ばれても `cases()` を全レセプトについて作る（レセプトごとに `patients.ingest`、さらに `uke.patientOf` が請求ごとに全ファイルを読み直す）。そのうえ氏名つきの請求一覧を組み立てる。版の一覧は `revision.ts:21`（SELECTABLE）、`uke-check.ts:21`（UKE_TRIAL）、`schemas/chart.ts:27`・`schemas/cases.ts:22`（zod の enum）で別々に作っている。`notes.claimOfNote` の `revisionById` 未定義チェックと `ukeTrial` の `includes` チェックは、schema の enum と同じことの二重の検査になっている。
  - 破綻シナリオ: 取り込んだファイルが増えると、カルテの画面を開くたびに全 UKE の読み直しと患者マスタの照合が走る。比較の側で 1 件でも例外が出ると（`compareOf` の中の `contextOf` の失敗など）、算定プレビューの「版を選んで試算する」が黙って消え、画面には何も出ない。比較の API の権限の行（ALL）を絞ると、試算の選択肢も一緒に消える。
  - 提案: `GET /api/chart/[id]/claim` の応答に `revisions`（SELECTABLE の id・label）を足し、claim-preview はそれを使う。失敗は握りつぶさずに出す。

- [O-14] 種別: 実装 / 深刻度: low
  - 指摘: 段の境目で、後の段が足したものを前の段の文書と画面の文が拾っていない。
  - 該当: (a) `docs/security.md:60-64`「消えるもの」と `app/uke/page.tsx:42` の確認の文に、請求ごとに確かめた事実（`claim_facts`。段 7c で追加）が入っていない。`src/server/app/erase.ts:70` は実際に消している。(b) `app/uke/[claimId]/page.tsx:6` の冒頭コメントは「開くと最新の版が選ばれた状態」だが、70〜73 行のコードと台帳 229 行は「選べる版の最初」。(c) 同じ 70 行のコメント「改定前のレセプトなら、その次に来た改定の版」は、今の UKE_TRIAL_REVISIONS が [r2026, r2027-06] だから成り立つだけで、コードは単に `revisions[0]`（コード表を持つ最も古い版）を選んでいる。
  - 破綻シナリオ: (a) 利用者は、医師あて・事務あてに残した答え（主病・看取りの場所など、患者の情報）がファイルと一緒に消えることを、確認の文から知ることができない。保守者は security.md を正として全表の走査のテストを読み、claim_facts が対象であることを見落とす。(c) 次の改定で r2028 がコード表つきで入ると、r2026 の期間内のレセプトでも、版のないレセプトの初期値は r2026 のままになる。2028 年の改定前のレセプトなら初期値は r2028 であるべきで、コメントの説明と食い違う。
  - 提案: (a) security.md と確認の文に「請求ごとに確かめた事実」を足す。(b)(c) 冒頭コメントを「選べる版の最初」に直す。(c) は、診療年月より後で最も早い版を選ぶ式にするか、コメントを「最も古いコード表つきの版」に直す。

- [O-15] 種別: 実装 / 深刻度: low
  - 指摘: ベテランのメンターの利用者 id `"vet1"` が、消す操作の中に直書きで写されている。
  - 該当: `src/server/app/erase.ts:14` の `VETERAN_CLERK = "vet1"`。コメントにも「instance.ts の askVeteran と同じ」とある。`src/server/instance.ts:123・218` が元の値。
  - 破綻シナリオ: ベテランのメンターの id を変える（例：テナントごとに振る）と、erase.ts だけが古い `"vet1"` を指し続ける。ファイルを消しても、ベテランのメンターのセッション（ベテランへの問いの本文。患者の情報を含む）が消えない。セッションは DB の外にあるので、§11-11 (d) の全表の走査のテストはこれを検出しない。
  - 提案: instance.ts の id を定数として export するか、`createErase` に引数で渡す。

### 確かめて問題なしとしたもの（指摘にしない）

- `CodeDef.base`・`quantity`：`src/uke/uke.ts:115・136`（書き出し）と `470`（読み取り）で使われている。`Revision.commentCodes`：`comments.ts`・`r17.ts` で読まれている。`SELECTABLE_REVISIONS`・`UKE_TRIAL_REVISIONS`・`COMPARE_REVISIONS`：画面・schema・API から呼ばれている。`src/uke/upload.ts`：`uploadClaimIdOf` が `src/server/app/uke.ts:54・165` から呼ばれている（`uploadClaimId` の export が外から使われていないだけ）。`fixtures/uke/extra.json`：`scripts/gen-uke.ts:41` の設定。
- `UkeOther.unit` は読まれていないが、設計 §11-11 の型どおりなので指摘しない。
- 事実の重ね合わせ（患者ごと → 請求ごと）は `cases.contextOf` の 1 か所だけ。点検の範囲の文は `COMMENT_CHECK_SCOPE` の 1 か所で、`comments.test.ts:153-154` が EM と照合している。コードの逆引きは `revisions/codes.ts` の 1 か所で、ORCA も UKE もここを通る。
- §11-8 の 5・6・(c)：`tests/engine/compare.test.ts` は値（6,260・EM の文言・`@ts-expect-error` 4 か所）で縛っており、実装の値を写しただけのテストではない。§11-11 (e)：`tests/engine/partial.test.ts` は「申告すると落ちる」反例（R01・R11・R17 の日付）まで持っている。
- 設計の「選べる版の初期値＝最新」との違い、R03・R10 を申告しなかったこと、`trial` の引数、カルテを消す画面の不足は、台帳 227・229 行に書いてあるので指摘しない。
