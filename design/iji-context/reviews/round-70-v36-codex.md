critic: codex/gpt-6.1-sol xhigh

1. **X-290｜high｜設計：正しい昭和以前の日付を「確定の誤り」にする。**  
   [§17-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3217)は850の元号を平成・令和に限定していますが、仕様は1〜5を許容し、現行`dateOfWareki`も対応済みです。例えば初診年月日`850100200`の昭和の日付が誤指摘になります。元号1〜5を維持してください。[公式仕様・パターン50](https://shinryohoshu.mhlw.go.jp/shinryohoshu/file/spec/R08rec2.pdf#page=17)

2. **X-291｜mid｜設計：R17が扱わない枝まで案内から消える。**  
   [§17-1](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3201)の項番単位の除外では、往診料`114000110`・項番0162の全枝が消えます。実マスターには医療機関名・介護施設名など別の枝がありますが、R17の`T162-reason`は`830100086`だけです。**採用済み方針の副作用で、L-220の具体的反例**です。除外をR17が実際に扱うコード・枝へ限定する必要があります。

3. **X-292｜mid｜設計：DD＝00の一律許容で、日の欠落を見逃す。**  
   [§17-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3217)では、年月日を要する`850100268`（初回年月日・熱傷処置）も`５０８１０００`で通ります。このコードはR17の担当外なので補完されません。L-222は実害のある論点です。年月専用コードを明示し、00の許容をそこへ限定してください。

4. **X-293｜mid｜設計：842の判定が数値の構文を検証しない。**  
   [§17-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3220)の「空でない・指定文字だけ」では、`＋`や`１２．３．４`も通ります。R17担当外の842コメントでは、そのまま見逃します。正規化後に符号・数字・小数点の並びを検証してください。現行`commentFormatOk`には既にその検証があります。

5. **X-294｜mid｜設計：同じ形式不正をR17とG07が二重に指摘する。**  
   [§17-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3225)はR17の「中身の食い違い」だけを抑制条件にしています。しかし現行[R17](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/rules/r17.ts:44)は、不正形式では`R17.comment_format`を出して中身の比較を止めます。例えば`850100106`の桁不足で両方が残ります。形式エラー同士の重複抑制も明記してください。


