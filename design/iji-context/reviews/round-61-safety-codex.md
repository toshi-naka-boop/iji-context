critic: codex/gpt-6.1-sol xhigh（反証・レンズ：安全性。対象 feat/practical-ab 5fe76a3..08b279e。ID は呼び出し側が X-200〜X-204 を振った：1→X-200、2→X-201、3→X-202、4→X-203、5→X-204）

読み取り専用の Node 実行で再現した5件です。重大度順に記載します。

1. **高／実装：申告だけで、原請求の減算行を高い1人区分へ置き換える**  
   [src/engine/derive.ts:309](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/engine/derive.ts:309)  
   **入力：** K2（2026-10）の管理料を `C002_2RO3_N14`（591点）に替え、施設申告を `building=none`・`note14=通常` とする。原請求の側として `claimNote14Side=減` も渡す。  
   **破綻：** `C002_2RO1`（3,685点）が導出され、保留は空。元請求に出る `R18.note14_conflict`・`R19.declaration_conflict` もプレビューの再検証では消える。導出先を1人と読んだ時点で、10人以上に限定した保留条件を抜ける。§15-4・L-126/L-152違反。

2. **高／実装：読めない請求を0回として集計し、2段目を省略できる**  
   [src/note14/count.ts:34](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/note14/count.ts:34)  
   **入力：** 2026-08〜10各月70人に `C001_1I` を10回ずつ算定したUKE（計2,100回）へ、各HO直後に未対応レコード `ZZ,x` を追加。3か月とも `confirmed=true`、追加回数0、特別関係なしで計算する。  
   **破綻：** 取り込みは210枚を受理するが、解析後の `unsupported`・`units=[]` を検査せず、各月を `state=ok`・0回とする。結果は `meets`・2段目不要となり、通常の申告下書きを開ける。読み取り不能と実績0を混同している。

3. **高／実装：読めない施設総管の患者を無警告で除き、減算対象を「通常」に逆転させる**  
   [src/server/app/note14.ts:87](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/server/app/note14.ts:87)  
   **入力：** 上記3か月の各月に在医総管Aと施設総管B/C/D。全員 `table8_2=true`、除外患者なし。B/C/Dの各RE直後へ `XX,unknown` を追加。回数は手入力2,100、紹介元は両読み5、患家看取り20、その他0とする。  
   **破綻：** 読めない9枚を先に除外し、①1人・②0人・⑤1人、`unknownCare=0` の自動下書きを返して `meets` になる。同じ請求から未対応レコードを除くと①1人・②3人・⑤4人、施設割合75%で `not_meets`。各月に1枚でも読める請求が残れば、不完全な集計を確定値として使ってしまう。

4. **中／実装：G11が人数の違う高い管理料候補に注意を付けない**  
   [src/engine/derive.ts:137](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/engine/derive.ts:137)  
   **入力：** K2から管理料を除き、`building=some`・患者の `buildingBand=50+`・`note14=通常`。G11候補に `C002_2RO1`（3,685点）を渡す。  
   **破綻：** 添え書きが空になる。同じ候補を加えた請求全体の点検では、R19が `C002_2RO5`（745点）への修正を指摘する。管理料の担当ルール一覧に、新設したR19がなく、§15-8で要求する人数の確認を通らない。

5. **中／実装：回数を直す添え書きが注14の減算を外す**  
   [src/generic/g11-rules.ts:76](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11-rules.ts:76)  
   **入力：** 訪問診療1回、`building=some`・`buildingBand=10-19`・`note14=減算`。G11候補に `C002_2RO3_N14`（591点）を渡す。  
   **破綻：** R01の添え書きは「正しい区分」として通常行 `C002_2NI3`（665点）を名指しする。正しい減算側は `C002_2NI3_N14`（399点）。直し先の検索が通常行だけを返すため、回数の修正と同時に減算まで外している。
