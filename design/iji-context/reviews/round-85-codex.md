critic: codex/gpt-6.1-sol xhigh（round-85 最後の狭い確かめ。codex は答えをまとめる前に usage limit で止まった。下は止まる前の途中の文と、実際に動かした再現の出力から呼び出し側が拾ったもの）

`forMonth` のない既存行では、11月に登録した10月から有効の認定が比較から外れ、10月が従来の要介護3から0へ変わるケースを再現しました。また、(a)を満たさない同月の「認定なし」が、(b)の期間つき認定へ進まず不明を返す経路も確認しました。
exec

2779:legacy base {"known":true,"value":3} []
2780:legacy HEAD {"known":true,"value":0} [{"ruleId":"R03","kind":"要件不足","lineRefs":["C002_N10_HOKATSU"],"messageKey":"R03.not_eligible","reference":"C002 注10 包括的支援加算（C002-2 注5 で施設入居時等医学総合管理料に準用）"}]
2781:failed (a) fallback Nov {"known":false}
2782:X410 [{"known":false},{"known":false}]
2783:X411 [{"known":true,"value":3},{"known":true,"value":3},{"known":true,"value":3}]
2784:X412 simple Dec 0
2785:X412 before Oct correction Dec 0
2786:X412 after Oct correction Dec 1 Oct end 2027-02
