批評役：使い捨ての批評・反証サブエージェント（モデル Claude Opus 5.5 / claude-opus-5-5）

## Round 28 — 2026-11-20 — 反証(安全性)

対象：feat/integration（HEAD 2320971）のうち v23（design.md §11）の実装。差分は 8aa200a..HEAD。台帳 2026-11-20 の行に書いてある仮置き・残る穴は指摘にしていない。

### 指摘

- [S-5] 種別: 実装 / 深刻度: high（**実測した**）
  - 指摘: UKE の「きざみ」区分（数量データつきのコード）の行は、算定日の文字列を「回数 × 数量データ」個つくる。1 日の回数の上限（9）は効くが、数量データ（最大 999）の掛け算には上限がない。そのため、数十 KB の UKE 1 本でサーバーのプロセスがヒープ切れで落ちる。取り込みと試算の両方で起きる。
  - 破綻シナリオ:
    1. （取り込みで落とす）同意済みの事務かベテランが、次の UKE を `POST /api/uke/upload` に送る。診療年月は 2026-10。SI 行は 600 行で、どの行もコード 160177770（D_GAIRAI_JINSOKU、`quantity: true`）、数量データ 999、点数 9990（10 点 × 999。単位ごとの点数の検査を通る値）、回数 279、算定日の欄は 31 日すべて 9。
       - `parseUke` は通る（各項目が上限の中）。`receiptOf` は合計の検査（`totalBad`）を先に計算するが、それを返すのは `mapClaim` の後（src/uke/uke.ts 517〜523）。このため `mapUnit` が単位ごとに `datesOf(yearMonth, days, 999)` で 279×999＝278,721 個の文字列を作って保持する（src/uke/uke.ts 433〜434、470〜475）
       - 実測（`readUke` を直接呼んだ。スクリプト `/private/tmp/claude-501/-Users-toshixa-Documents-iji-context/2b55f9e0-1fbd-45be-a64c-446b804ed7ab/scratchpad/r28-safety/bomb.ts`）：1 行あたり約 12MB のヒープを使う。4KB（40 行）で heap 498MB・686ms。60KB（600 行）で 10.6 秒後に `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`（RSS 4.47GB）
       - 上限 1MB・5,000 行の中で十分に起こせる。回数制限（`limit: "upload"`）は 1 回目から効かない。落ちるのは Next.js のプロセス 1 つで、そこには全クリニックが載っているので、全テナントが止まる
    2. （置いておいて、開くたびに落とす）同じ形で、診療年月が版のない月（2024-03）、点数 0、HO と GO の合計 0 のファイルにする。
       - 版のないレセプトは `receiptOf` が `mapClaim` を呼ばずに `noRevision` で受け取る（src/uke/uke.ts 519）。このため取り込みは成功し、ファイルは保存される
       - 誰か（事務長でも）が一覧からそのレセプト `/uke/U<n>-1` を開くと、画面は初期値の版で `GET /api/uke/claims/[claimId]/trial` を呼ぶ。`ukeTrial` が `mapClaim(parsed, rev, true)`（src/server/app/uke-check.ts 83）を回し、lenient なので点数の食い違いでも行を保持する
       - 実測（`/private/tmp/claude-501/-Users-toshixa-Documents-iji-context/2b55f9e0-1fbd-45be-a64c-446b804ed7ab/scratchpad/r28-safety/bomb2.ts`）：取り込みは `noRevision=true` で受理された。40 行で、試算の `mapClaim` だけで heap 498MB。行数を増やせば 1. と同じく落ちる。ファイルを消すまで、開くたびに再現する
  - 提案:
    - 数量データ × 回数（行あたりの算定日の数）に上限を置き、超えたら行番号つきで断る。上限はたとえば `UKE_LIMITS.maxDailyCount * 31`、またはきざみの項目数の上限を区分ごとに持つ
    - 合わせて、算定日の文字列を作る前に、点数と合計の検査を済ませる
    - `parseUke` の段階で数量データの値域を決めれば、取り込みと試算の両方が 1 か所で塞がる

- [S-6] 種別: 実装 / 深刻度: mid（読んだだけ）
  - 指摘: ファイルを消す操作は、メンターのやり取りのうち、`clerks.session_id` に今入っている 1 つのセッションしか消さない。それより前のセッションの記録は、サーバーのディスクに残る。前のセッションとは、同期の世代が変わったときや、続きに失敗して作り直したときに捨てられたセッション。
  - 破綻シナリオ:
    - 事務 A が、取り込んだ請求 U3-1 の問題でメンターと話す（セッション s1。発言の本文と毎回の判定の文脈が、SDK の記録 `{sessionId}.jsonl` に残る）
    - そのあと、ベテランが知識を承認して Skill の同期の世代が変わる。A の次の発言で `prepare` が `sessionId: null` を返し（src/server/instance.ts 184〜186）、新しいセッション s2 ができて `clerks.session_id = s2` になる。`withSession` の失敗時のやり直し（206〜214）でも同じことが起きる
    - ベテランが `DELETE /api/uke/uploads/<sha256>` を呼ぶ。`deleteUpload` が返すのは `{ id: A, sessionId: s2 }` だけ（src/server/app/erase.ts 84〜88）。`deleteUkeUpload` は s2 を `forgetSession` で消し、作業場所（cwd）を `rmSync` する（src/server/instance.ts 196〜201）
    - SDK の `deleteSession` が消すのは「ローカルの projects ディレクトリ」の `{sessionId}.jsonl` で（sdk.d.ts 691〜706）、cwd の中ではない。このため、cwd を消しても s1 の記録は残る
    - U3-1 についての A の発言は s1 に入ったまま残る。発言には氏名などを打ち込み得る（§11-11「外せないもの」）
    - ベテランのメンター（vet1）も、`persistSession` が既定のまま（src/mentor/peer.ts。mentor・veteranMentor だけ `persistSession: false` がない）なので同じことが起きる
    - 設計 §11-11 の「消すもの：メンターのやり取りと作業場所」を満たさない。全表の走査のテストは DB しか見ないので、この漏れは捕まらない
  - 提案:
    - 消す相手の医療事務ごとに、`listSessions({ dir: cwd })` で過去のセッションも列挙して消す
    - または、セッションを作り直すときに古いセッションを `forgetSession` する

- [S-7] 種別: 前提 / 深刻度: mid（読んだだけ）
  - 指摘: `DELETE /api/chart/[id]` が消すのは `chart_notes` の 1 行だけ。そのカルテの本文（A・P の欄）は、照合から作った医師確認の「指示」に写されて query-log の json と md に入っている。その写しは消えずに残る。
  - 破綻シナリオ:
    - 事務 A が K3 に訪問カルテを書いて確定する。A 欄・P 欄には、実在の患者の病状を自由記述で書いている
    - 照合（`crosscheckOf`）が不一致を見つける。`indicators` には `カルテ <日付>` として `A: … / P: …` の原文が入る（src/uke/crosscheck.ts 54〜57。`chartWithNotes` が本人のカルテを entries に重ねる。src/chart/notes.ts 56〜63）
    - A が `POST /api/crosscheck` で医師確認を送る。`sendCrosscheck` → `askMissing` → `createQuery` が、その本文を `query-log/<id>.json` と `.md` に書く（src/server/app/doctor.ts 66〜71、src/query/doctor-query.ts 82）
    - A が、そのカルテを `DELETE /api/chart/[id]` で消す（src/server/app/notes.ts 65〜70）。本文は `GET /api/doctor` から読める形でディスクに残り、カルテを消した本人には残っていることが分からない
    - 設計 §11-11 は「カルテを書く画面から入れた記録は、今の『カルテを消す』操作に従う（なければ足す）」としか書いておらず、写しをどう扱うかが決まっていない
  - 提案: ユーザーに次のどちらにするかを決めてもらう。
    - (a) カルテを消すときに、そのカルテを根拠にした医師確認も消す。医師の回答で確定した傷病名（`confirmedDiseases`）も一緒に消える
    - (b) 医師確認は残し、indicators の本文だけを「（消したカルテ）」に置き換える
    - どちらにしても、注意書きか画面の確認文に「医師確認に写した本文の扱い」を書く

- [S-8] 種別: 実装 / 深刻度: low（読んだだけ）
  - 指摘: メンターの応答を待っている間にファイルを消すと、応答が戻った後の書き込みで、消した請求の痕跡が DB とセッションに戻る。
  - 破綻シナリオ:
    - 事務 A が U3-1 の問題でメンターに話しかける。`talkToMentor` は `q` を読んだ後、LLM を数秒待つ
    - その間に、ベテランが U3-1 のファイルを消す。トランザクションは `questions` を消し、A の `session_id` を NULL にして、セッションを消す
    - A の応答が戻ると、次の書き込みが起きる（src/server/instance.ts 286〜290）
      - `a.setSession(A, r.sessionId)`：U3-1 の会話を含むセッションが再登録される
      - `a.setSetting("smalltalk:<消えた問題 id>")` と `vent:…`：消した問題の id が `app_settings` に戻る
    - 待っている間にメンターが `ask_human` を呼んでいれば、`peer_questions` に `claim_id = 'U3-1'` の行が新しくできる
    - 「消した後、DB のどの表にもその請求 id が残らない」（§11-11 の完了条件）が、並行して操作したときに破れる
  - 提案:
    - 応答の後の書き込みの前に、問題（`a.question(id)`）がまだあるかを確かめ直す。なければ、セッションを `forgetSession` して書き込まない
    - または、消す操作の側で、そのテナントで実行中のメンターの呼び出しが終わるのを待つ

### 問題なしとした観点（参考）
- 権限表は全 73 行が external・patientData を申告している。route.ts のうち AI・音声を呼ぶもの（chart・chart/image・chart/soap・mentor・proxy・notice・voice 2 本・開発用 2 本）は、すべて `ai`／`voice` を申告している。`route()` は権限の検査の後に同意を見ている。`runOnce` と `elevenlabs` の 2 つの入口も、自分で `assertMaySend` を呼ぶ。`outboundForBundled` を app/・src/server/ から呼んでいるところはない
- メンターに渡す文脈は `claimForAi`（claimId・yearMonth・history の区分）、判定の `ruleId`／`kind`／`lineRefs`／`missing`／`reference`、照合の固定文 `rule.why` だけ。患者の氏名、UKE の傷病名の文字列、コメントの文字データ、`Finding.params` は入らない
- テナントは DB とディレクトリごとに分かれている。sha256・claimId・カルテ id はスキーマで形を絞っている。DELETE も、GET 以外の Origin の検査（proxy.ts → origin.ts）を通る。`acceptNotice` は今の版しか受けず、`acceptedNotice` は呼ぶたびに DB を読む
