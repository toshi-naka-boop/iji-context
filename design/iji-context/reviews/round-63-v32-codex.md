critic: codex/gpt-6.1-sol xhigh（v32 の批評。ID は呼び出し側が X-220〜X-222 を振った：1→X-220、2→X-221、3→X-222）

1. **重大／前提：L-161 が頼る区分誤りの検出が存在しません。**  
   [L-161](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2723) は、訪問診療料の居住による区分誤りを R16・R19 などが指摘するとしています。しかし両者は管理料が対象で、訪問診療料の担当は [R01・R10・R13](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/derive.ts:140) です。同一建物の診療人数を2人とし、「同一建物居住者以外」を選んだ反例でも、現行 `evaluate` の指摘は空でした。先頭候補を誤って選んだ際の検出を保証できないため、この前提の訂正か検出手段の設計が必要です。

2. **重大／実装：評価が別の行為の候補を流用し、取り出し漏れを正解に数えます。**  
   [run-eval.ts](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/eval/run-eval.ts:111) は、その日の全行為・子要素の候補を横断して採点し、同じ抽出行を何度でも使います。保存結果でも「内分泌学的検査3項目」という1行から、個別に取り出していない複数検査が加点されています。これでは v32 の「まとめ書きを分ける」が直らなくても合格し得ます。引用・親子関係などで期待行為と対応付け、抽出行の重複使用を防ぐ必要があります。[段18d](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2624) の「退行0」も、誤加点を維持する条件にならないよう見直すべきです。

3. **中／前提：L-163 の「当てようのない8個」という説明が成立しません。**  
   [L-163](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2725) が除く処方箋料は、正解データでは「院外処方箋を発行」から [1行為・1コード](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/fixtures/charts/K11-abbrev.json:314) で表せ、新しい5文も明示的に抽出を求めています。また、1行為1コードという画面の制約は、複数候補の存在を数える現評価で「不可能」の根拠にはなりません。66行為の参考値を到達可能な対象の成績と誤読させるため、74行為での合否は維持しつつ、除外集合の意味と採点定義を整合させる必要があります。
