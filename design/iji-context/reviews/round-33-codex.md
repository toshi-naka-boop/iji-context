critic: codex/gpt-6.1-sol xhigh

1. **[設計/high] 異なる意味の問いを `sameDaySeparate` に保存する。**  
   [§13-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1843)は「訪問診療後の急変往診か」を「別々の診療か」と同一視しています。しかし、往診が先でも別々の診療なら後者は真です。既存の真を流用するとG05の例外を誤って認め、逆に新しい問いの「いいえ」を偽として保存すると、R09が別々の実施2回を1回と数えます。[§11-5](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1354)で分離済みの `sameDayOushinAfterVisit` を使う必要があります。

2. **[設計/high] 例外の否定だけで、背反自体の成立まで確定させる。**  
   [§13-4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1849)は、人が「いいえ」と答えると確定にします。例えば「同時」の表の救急搬送診療料×往診料が、同日の別々の診療として別単位にある場合、例外に当たらないという回答だけでは同時実施を証明できません。それでも併算定不可と断定します。現行実装が保持する [`hit.sure` と `t.weak(row)` の制約](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/generic/g05.ts:56)を、例外判定後にも適用する必要があります。

3. **[設計/high] 原文確認に失敗した例外が、判定から消える。**  
   [§13-1](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1804)は、確認できない例外を「EMに入れずウに回す」としますが、設定はEMと1対1なので、そのウを登録できません。例えばC109×J000で、入院中の例外だけ登録され、[熱傷の例外](/Users/toshixa/Documents/iji-context/design/iji-context/sources/research/tokurei-group3.md:73)が確認失敗で脱落すると、入院外の熱傷処置にも「全部の例外が当たらない」が成立します。[§13-2](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1834)には、例外の収録が完全かを確認する仕組みか、脱落した例外を不明として残す仕組みが必要です。

4. **[設計/medium] 確定の登録キーと出力キーが一致しない。**  
   §13-2の出力は `G05.exception_none` ですが、[§13-4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1850)が登録する許可キーは `G05.exception_none:HX-nn` です。現行の[確定判定](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/generic/index.ts:59)は `certain.has(f.messageKey)` の完全一致なので、標本確認を終えて登録しても条件つきのままです。例外IDを含む許可キーの照合方法と、複数例外がある場合の昇格条件を定義する必要があります。
1. **[設計/high] 異なる意味の問いを `sameDaySeparate` に保存する。**  
   [§13-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1843)は「訪問診療後の急変往診か」を「別々の診療か」と同一視しています。しかし、往診が先でも別々の診療なら後者は真です。既存の真を流用するとG05の例外を誤って認め、逆に新しい問いの「いいえ」を偽として保存すると、R09が別々の実施2回を1回と数えます。[§11-5](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1354)で分離済みの `sameDayOushinAfterVisit` を使う必要があります。

2. **[設計/high] 例外の否定だけで、背反自体の成立まで確定させる。**  
   [§13-4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1849)は、人が「いいえ」と答えると確定にします。例えば「同時」の表の救急搬送診療料×往診料が、同日の別々の診療として別単位にある場合、例外に当たらないという回答だけでは同時実施を証明できません。それでも併算定不可と断定します。現行実装が保持する [`hit.sure` と `t.weak(row)` の制約](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/generic/g05.ts:56)を、例外判定後にも適用する必要があります。

3. **[設計/high] 原文確認に失敗した例外が、判定から消える。**  
   [§13-1](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1804)は、確認できない例外を「EMに入れずウに回す」としますが、設定はEMと1対1なので、そのウを登録できません。例えばC109×J000で、入院中の例外だけ登録され、[熱傷の例外](/Users/toshixa/Documents/iji-context/design/iji-context/sources/research/tokurei-group3.md:73)が確認失敗で脱落すると、入院外の熱傷処置にも「全部の例外が当たらない」が成立します。[§13-2](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1834)には、例外の収録が完全かを確認する仕組みか、脱落した例外を不明として残す仕組みが必要です。

4. **[設計/medium] 確定の登録キーと出力キーが一致しない。**  
   §13-2の出力は `G05.exception_none` ですが、[§13-4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1850)が登録する許可キーは `G05.exception_none:HX-nn` です。現行の[確定判定](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/generic/index.ts:59)は `certain.has(f.messageKey)` の完全一致なので、標本確認を終えて登録しても条件つきのままです。例外IDを含む許可キーの照合方法と、複数例外がある場合の昇格条件を定義する必要があります。
