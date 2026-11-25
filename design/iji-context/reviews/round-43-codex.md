critic: codex/gpt-6.1-sol xhigh

**high 2件を含む、4件の不具合があります。**

1. **[実装 / high] 同一業務時刻で再承認すると、古い押下が復活する。**  
   同じ知識で請求A・Bを確認後、Aの返戻で要再検証にし、時計を進めず再承認すると、以前と同じ `status_since` になります。Bに残る古い押下が有効と判定され、押し直さずG05が消えます。インメモリで再現しました。§14-3の再承認後の失効条件に違反します。  
   該当：[g05.ts:223](/Users/toshixa/Documents/iji-context/.claude/worktrees/stage-16/src/generic/g05.ts:223)

2. **[実装 / high] 別理由での再承認により、保留中の改定棚卸が失われる。**  
   比較データ不足で `pending` になった後、返戻などを理由に再承認すると、`status_since` が改定日より後になります。その後データが揃っても比較処理をスキップするため、差分のある知識が承認済みのまま使われます。再現では比較呼び出しが初回の1回だけでした。  
   該当：[review.ts:247](/Users/toshixa/Documents/iji-context/.claude/worktrees/stage-16/src/lifecycle/review.ts:247)

3. **[実装 / medium] 修正版の承認画面が、実際に使われる向き・条件を表示しない。**  
   `avoid` → `allow` に修正しても、候補の要約は旧来の「併せて算定できません（修正の候補）」を引き継ぎます。新しい条件も本文に入りません。承認キューは要約と本文しか表示しないため、承認者が禁止の知識だと思って承認すると、実際には指摘を消せる知識になります。候補生成で再現しました。  
   該当：[review.ts:676](/Users/toshixa/Documents/iji-context/.claude/worktrees/stage-16/src/lifecycle/review.ts:676)、[page.tsx:80](/Users/toshixa/Documents/iji-context/.claude/worktrees/stage-16/app/knowledge/page.tsx:80)

4. **[実装 / medium] 誤って押した「条件に当たる」を訂正できない。**  
   押下後に条件不一致が判明しても、画面には取消操作がなく、APIも `true` 以外を拒否します。取消処理を呼ぶ入口は返戻報告だけなので、正当に訂正できずG05の抑制が残ります。返戻報告で代用すると、請求の訂正のために知識全体を要再検証にしてしまいます。  
   該当：[fact-input.tsx:212](/Users/toshixa/Documents/iji-context/.claude/worktrees/stage-16/app/fact-input.tsx:212)、[facts.ts:66](/Users/toshixa/Documents/iji-context/.claude/worktrees/stage-16/src/claim/facts.ts:66)
