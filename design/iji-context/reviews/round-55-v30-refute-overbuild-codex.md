critic: codex（gpt-6 系、xhigh）／レンズ：作りすぎと設計からの外れ（実際は実装の欠陥も挙げた）

実行モデル：GPT-6系 Codex（詳細なモデルIDは環境に未提示）。補助レビュー：`gpt-6.1-sol`。

1. **X-154｜高｜実装：別の日の施設基準違反で、正当な取り忘れまで隠す。**  
   [g10.ts:62–82](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g10.ts:62) は同一コードの全単位の日をまとめ、[181行](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g10.ts:181)で全単位に同じ判定を付ける。算定開始が10月15日、既請求が5日、追加候補が20日なら、開始前の違反で20日の候補まで隠れた。単位別判定と、既存の別日の違反では候補を抑えない要求（[設計2298行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2298)、[2455行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2455)）に反する。

2. **X-155｜高｜実装：設計にない「候補は一組だけ」の制約で背反関係が消える。**  
   [g11.ts:671–675](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:671)は、一度組に入った候補を別の組に入れない。A–B・A–Cが背反区分3の小さな表では、A/Bの`missing_either`と注意書きなしのCが出て、A–Cの関係が消えた。「組ごとに1件」と、残る関係には注意書きを付ける約束（[設計2429行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2429)、[2446行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2446)）からの逸脱。

3. **X-156｜中｜実装：子の薬・器材の量を合計せず、正しい請求を過量と指摘する。**  
   [g11.ts:495–498](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:495)は子を一行ずつ当日の請求総量と比較する。同日・同じ親の薬がカルテに10gずつ二行、請求が20gなら、誤った`quantity_more`が二件出た。同じ親・同じ子の量を合計する要求と、コード・日ごとに一件という要求（[設計2413行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2413)、[2422行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2422)）に反する。

4. **X-157｜中｜実装：任意で残した未対応行為を、点検結果から補正できない。**  
   [g11.ts:429–433](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:429)は未対応行為を件数だけにし、[app/torikawasure.tsx:47–50](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/app/torikawasure.tsx:47)にも候補選択入口がない。保存済みカルテの再保存も[notes.ts:156](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/server/app/notes.ts:156)で拒否する。院内薬の対応選択を任意で残すと、後からコードを選んで次回点検へ反映する経路が閉じる（[設計2360行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2360)、[2482行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2482)）。

5. **X-158｜中｜実装：判断料の候補を作る根拠を、黙ってカルテだけに狭めている。**  
   [g11.ts:530–537](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:530)は検査グループを`acts`からしか集めない。請求にPTがあり判断料が抜け、貼ったカルテには別の処置だけがある場合、判断料の候補が出なかった。設計は「その月の請求と確かめた行為」の検査項目を根拠とする（[2395行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2395)）。

X-154〜156・158はメモリ内の小さな表で再現確認。実データのマスターは未使用。ファイル変更なし。


