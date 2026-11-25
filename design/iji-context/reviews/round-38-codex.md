critic: codex/gpt-6.1-sol xhigh

新規の指摘は3件です。**highはありません。** 実マスター（20261102）とメモリ内DBで再現しました。

1. **[実装 / medium] 別の日の「同じ算定単位」が、残った日の確定条件にも使われる**  
   [g05.ts:238](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/generic/g05.ts:238)  
   HP-14で、5日は往診料・救急搬送診療料を同じ単位、10日は別々の単位に置き、HX-10を5日「当たる」、10日「当たらない」と回答すると、10日の指摘が「同じ算定単位（10日）」になります。`units`も5日の単位を指します。出荷設定では条件つきですが、設計の受入条件どおりHP-14を`certain`に加えると、10日まで誤って確定になります。§13-4(a)に反し、算定日ごとの単位の照合が必要です。

2. **[実装 / medium] EMで未確定とした電話再診を、往診料がないだけで「例外に当たらない」にする**  
   [haihan-exceptions.json:948](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/config/haihan-exceptions.json:948)  
   同日に訪問診療料`114001110`と電話等再診料`112007950`があり、往診料がない請求では、HX-11の`pre`で打ち切られ、問いなしの`G05.exception_none`になります。EM §2-12のHX-11は「外来の受診・電話の再診の場合は決まらない」としていますが、その回答選択肢に到達できません。条件つき表示でも、未確定な場合を「レセプトで例外を否定できた」と説明する食い違いです。

3. **[実装 / low] 複数組の回答を同時に取り消すと、監査対象のキーが欠ける**  
   [facts/route.ts:16](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/app/api/claims/[claimId]/facts/route.ts:16)  
   同日のHX-01の2組に「その他」を残した後、`sameDayOushinAfterVisit=true`を直接保存すると、両方の回答が取り消されます。しかし、連結した監査対象は94文字となり、[audit.ts:25](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/server/audit.ts:25)の80文字制限で、2組目のキーが途中で切れます。取消処理は成功しても、その対象を監査ログから特定できず、§13-3の記録要件を満たしません。
