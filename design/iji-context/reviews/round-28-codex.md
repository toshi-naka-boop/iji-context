critic: codex/gpt-6.1-sol high（1 回目は xhigh で 15 分の打ち切りにかかり結論なし。範囲を R07・R09・R10・R17・predicates・comments・index・uke の mapUnit/mapClaim に絞って回し直した）

tokens used
52,308
重大度順に3件。指定コードを依存の最小スタブとともに隔離実行し、以下の見逃しを再現しました。

1. **高：文書提供が不明だと、対象外患者への緊急往診加算を見逃す。**  
   該当：[r10.ts:33](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/rules/r10.ts:33)、[index.ts:85](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/index.ts:85)  
   **入力**：在支診。11月10日に往診料・緊急往診加算、11日に訪問診療料を各1回。`emergencyEligible={known:true,value:false}`、`contactDocProvided={known:false}`、`partial=false`。  
   **破綻**：文書提供の情報不足でルール全体を中断し、確定している `R10.kinkyu_not_eligible` まで消える。文書提供の回答によらず、この加算の要件不足は指摘できる。

2. **中：対象外単位があるだけで、緊急往診加算の確定した要件不足を捨てる。**  
   該当：[r10.ts:27](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/rules/r10.ts:27)、[index.ts:103](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/index.ts:103)  
   **入力**：往診料・緊急往診加算を各1回、訪問診療料なし。`emergencyEligible={known:true,value:false}`。無関係な対象外単位を含み、`partial=true`。  
   **破綻**：`check` が返した `kinkyu_not_eligible` を空の `soundWhenPartial` により捨て、`unsupportedLines` に置き換える。§11-11が明示する「その行と事実だけで言える要件不足」の保持に反する。

3. **中：対象外単位があると、包括的支援加算の状態コメントと確定事実の矛盾を見逃す。**  
   該当：[r17.ts:19](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/rules/r17.ts:19)、[index.ts:103](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/index.ts:103)  
   **入力**：包括的支援加算あり、`commentsKnown=true`、`recordsKnown=true`。項番178の要介護3コード（版定義の `careLevel:3`）を記載し、`facts.careLevel={known:true,value:2}`。無関係な対象外単位により `partial=true`。  
   **破綻**：生成済みの `comment_mismatch_hokatsuState` を捨て、`unsupportedLines` に置き換える。§11-13では、この比較を省く条件は該当事実の不明であり、対象外単位の追加で矛盾は解消しない。

**結論：確定した誤りを見逃す3件で反証成立。点数誤りは今回の範囲では確証を得ていません。ファイル変更なし。**
