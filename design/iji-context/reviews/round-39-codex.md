critic: codex/gpt-6.1-sol xhigh

1. **[設計/high] 注記の条件を満たさない請求でも指摘が消える。**  
   [`conditionNote`は機械判定できない近似条件](design/iji-context/design.md:1933)ですが、[承認済み`allow`はコード組だけでG05を抑止](design/iji-context/design.md:1950)します。例えば「支払基金への照会で確認した条件に限る」という知識が、国保連の請求にも適用されます。今回の請求で条件が成立するかを確認する工程がありません。

2. **[前提/high] 既存の院内層では改定・改選トリガーが効かない。**  
   [§14-1](design/iji-context/design.md:1935)は既存の仕組みで改定後に要再検証になるとしていますが、[実装の院内層は`revision`・`reappointment`ともに`false`](.claude/worktrees/integration/src/lifecycle/layers.ts:19)です。改選直前に承認した`allow`が、改選後も承認済みのまま指摘を消し続けます。

3. **[設計/high] 公的文書との照合が`codePair`知識を必ず対象外にする。**  
   [新形式は`kubunAll`・`ruleId`との併用を禁止](design/iji-context/design.md:1931)しています。一方、[既存の公的文書照合はこの二つからしか対象区分を取得しません](.claude/worktrees/integration/src/official/match.ts:12)。同じ組の併算定を否定する文書を追加しても区分集合が空になり、矛盾の表示も再検証トリガーも起きません。

4. **[設計/medium] 会議で承認した修正版をG05が参照できない。**  
   [既存の修正版作成はベテラン層](.claude/worktrees/integration/src/lifecycle/review.ts:631)ですが、[§14-3の参照対象は院内層](design/iji-context/design.md:1948)です。要再検証の知識に「直す必要がある」と回答し、作られた修正版を承認しても、元は停止、新版は参照対象外となり、次の請求に使えません。

5. **[設計/medium] G05で使い続けても「未使用」で再検証になる。**  
   [§14-3](design/iji-context/design.md:1957)には、適用時に`USED`を記録する規定がありません。近似知識は[提出結果の集計対象外](.claude/worktrees/integration/src/lifecycle/review.ts:87)で、院内層はメンターの引用対象からも外れます。毎月G05を抑止していても使用日時が更新されず、180日後の会議でidleによる要再検証になります。
