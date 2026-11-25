critic: codex/gpt-6.1-sol xhigh

tokens used
158,126
1. **【high／設計／C-91 未解消】頻回訪問の摘要で、訪問年月日の欠落を見逃す。**  
   [§11-13 の項番167](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1571)は「各1件以上」のままで、[日付の集合照合](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1591)も項番176だけです。  
   **破綻例：** 別表第七に該当せず、急性増悪で11月2・3・4・5日に訪問した請求に、必要性・判断日と、訪問年月日「11月2日」だけを記載する。設計どおりなら各コードが1件あるため通り、残る3日分の記載もれを検出できません。[記載要領の項番167](https://www.mhlw.go.jp/content/12400000/001707506.pdf#page=123)が求める訪問年月日の網羅を、改訂後も保証できていません。
