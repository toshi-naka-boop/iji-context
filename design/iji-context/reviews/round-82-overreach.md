critic: claude/claude-opus-5-5

## Round 82 — 2026-11-24 — 反証(過剰実装・設計からのずれ)

対象：git diff f8144cd..feat/v37-cdf（worktree .claude/worktrees/v37-cdf）。設計 §18（v38・§18-12 を含む）、台帳の解決済みは蒸し返していない。実測はしていない（4 件とも静的に読めば白黒がつく）。

### 指摘

- [C-540] 種別: 実装 / 深刻度: mid
  - 指摘: 判断 F で除いた条件つきの指摘（R20・R21、v38 の R01.visit2_only・R11.rapid_needs_same_day_doc_visit2）が、通常の問題の正誤・メンターの文脈・選択モードでは確定の誤りとして数えられている。除いたのは医師確認の練習問題（questions.ts 106 行）だけで、扱いが揃っていない。
  - 破綻シナリオ: 聞き取りで「要支援 2」を残した患者の月末の UKE の問題（通常モード）で、本人が UKE のとおり C010 を入れて確定する。`caseFor` → `caseOf` は `ctx.care` を持つので R20.renkei（要件不足・conditional=1）が出る。`practice.ts` の `isCorrect`（`findings.every(kind === "情報不足")`）が偽を返し、連続正解が 0 に戻る。`app/work/page.tsx:283` はメンターに「新人の誤り」として解説を頼み、`mentor/prompt.ts:116` は conditional の印を落とした findings を「ユスティの判定（これが正）」として AI に渡す。`workspace.ts:162` は本人の CLAUDE.md の「確認が入ったルール」に R20 を数える。`practice/choice.ts` の `okWith` も同じ `isCorrect` を使うので、選択モードでは C010 を含む選択肢が誤りになる。申告を確かめていない前提（判断 F の「確定に入れない」）が、本人の評価と AI の言い方では確定として扱われる。
  - 提案: `isCorrect` で `params.conditional === "1"` を除く（questions.ts の個別の除外は消す）。`turnContext` の findings に `conditional` を渡すか、条件つきのものは「申告のとおりなら」と添えて渡す。`clerkMemo` の数え方からも除く。テストを 1 本足す（申告つきの請求で、条件つきの指摘だけなら correct が真）。

- [C-541] 種別: 実装 / 深刻度: mid
  - 指摘: 聞き取りの画面の対象（`careCheck` の asks）は 4 つの問いの空きしか見ていない。§18-5 の「使う項目が『分からない』」「確かめ直す日を過ぎた」に当たる患者のうち、問いに出ないものは「見ていません」の人数に入るのに、画面にカードが出ない。
  - 破綻シナリオ: (a) 住まいの種別で「特養」を選び、入所先の施設は付けない（画面では「任意」）。R20 ① は看取りの値が「分からない」になって `careUnknown` を出すが、`residence` があり `home` が undefined なので residenceType を聞かない。特養なので `askShortStay` も偽になり、asks が空になる。月の帯は「見ていない 1 人」と出るが、`targets` は asks のない行を捨てるので、その人のカードはどこにもない。(b) ほかの機関の行の在医総管を取る側が「分からない」のとき、`!c.others` が偽なので others を聞かない（⑤ は「見ていません」のまま）。(c) 「ないと確かめた」がある患者の (Ⅰ)2 の月は ⑥ が `noReferrer` を出すが、others を聞かないので、求めた機関の行を足す入口がない（C-512 の趣旨）。(d) 同じ月に 2 回の短期入所で日付が欠けているときと、宿泊で「退院日から」が分からないときも同じ。どれも完了条件 8（画面で答えると「見ていません」が消える）がこの画面では満たせない。
  - 提案: asks を「その請求の `careScopeNotes` に出た文」から引く。少なくとも次を足す：施設の値が「分からない」（施設を付けていない・確かめ直す日を過ぎた）なら residenceType、取る側が分からない・⑥ の求めた機関がない・⑦ の三値が分からないなら others、短期入所の日付・退院日からが欠けているなら shortStay。あわせて「notDone なのに asks が空」の請求がないことをテストで縛る。

- [C-542] 種別: 実装 / 深刻度: low
  - 指摘: v38 で「申請中」を足したときに、患者の画面の P07（要介護認定の有効期間）の除外の一覧に「申請中」が入っていない。
  - 破綻シナリオ: 聞き取りか患者情報の欄で「申請中」を残す。`patients.ts` の `profileOfPatient` は除外の一覧が `["認定なし", "分からない"]` だけなので、`careCertification: { validUntil: null }` を返す。`checks.ts:227` の P07.missing（有効期間が入っていない）が患者情報の欄に出て、申請中で有効期間がまだない正しい状態を入力の漏れとして見せる。
  - 提案: 除外の一覧に「申請中」を足す（区分と期間のある行だけを期限の知らせに使う）。

- [C-543] 種別: 実装 / 深刻度: low
  - 指摘: 患者の画面の「古い入力です。住まいの種別で入れ直してください」の案内のリンク（`/uke/care-check?claim=…`）の `claim` を、聞き取りの画面が読んでいない。
  - 破綻シナリオ: 9 月と 10 月の UKE を取り込んだクリニックで、10 月の請求の患者の画面からリンクを押す。`care-check/page.tsx` は `month` しか読まないので `months[0]`（9 月）を開く。その患者のカードは 9 月にないか、9 月の分として出る。そこで答えると fromMonth＝9 月で残り、C-513（開いた UKE の診療年月で残す）の意図と食い違う。
  - 提案: リンクにその請求の `month` を付ける（`?month=<yearMonth>`）。または画面で `claim` を読み、その請求の診療年月を選ぶ。

### 確認して問題なしとした観点（参考）
- 設計にない機能・設定：config/care.json（otherNoneMonths・staleMonths）、nurseInsurance の入れ物、care_homes の homeId による追記、まとめて「使っていない」は、どれも §18-2・§18-3・§18-5 にたどれる。knowledge/system/r20・r21 と skills は、seed の「版のルールと 1 対 1」というすでにある不変条件から要る。文に点数はなく、禁止語も見つからなかった（追加行を grep した）。
- ついでの直し：notes.ts（upTo.care。C-500 の D03）、erase.ts（FR-168）、uke.ts の同梱ハッシュ（§18-12 の 6）、g11.ts・day-type・r10・r11（v38 の 8）、questions.ts（判断 F）は、どれも依頼にたどれる。
- テストの緩め：既存のテストの書き換えは、residence→residenceType（C-494）、「今日より前」の受け付け（§18-1）、ルールの本数（19→21）、コードの数（279→283）、comments-real の EM 待ちの組（+4。今までと同じ扱いで、ほかの組は今までどおり落とす）、partial の reads（(Ⅰ)2）だけ。どれも設計の変化にたどれ、判定を弱めたものはない。
- 内部のキー：既知の「今の申告」（type:・status:）のほかに、画面に出る文は FINDING_TEXT・FACT_LABEL・pendingText（care_family・visit2Mixed・visit2Undecided を含む）が受けていた。なお既知の件は、短期入所が「使った」のときは `uses:` の中身（`careHomeId:H…`・`fromDischarge:` など、施設の内部 id）まで出る。直すときはあわせて扱う。
- 患者情報の漏れ：監査ログの target は `claimId・項目の鍵` か固定の文字列で、値・機関名・施設名はない。AI への文脈は `claimForAi` と、ruleId・kind・lineRefs・missing・reference だけの findings で、params（前提の文＝申告の値）は渡らない。ここでの不備は C-540 の「条件つきの印が落ちる」だけ。
