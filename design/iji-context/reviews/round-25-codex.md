critic: codex/gpt-6.1-sol xhigh

tokens used
171,053
重大度順に5件です。指定の前提と台帳末尾の決着は維持しています。ファイルは変更していません。

1. **【high／設計】同意の確認が、カルテの外部送信より後になる。**  
   [§11-11](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1450)は「カルテの確定」を同意必須にしていますが、現実装は[writeChart](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/server/instance.ts:282)で保存直後に事実抽出へ送り、SOAP整理も確定前に送信します。**未同意の利用者が実患者の文章をSOAP整理に渡すだけで、確定操作を経ずに外部送信できます。** 同意必須の範囲を、保存・整形・抽出を含む送信入口ごとに定める必要があります。

2. **【high／設計】請求単位の削除と、実際の保存単位が一致しない。**  
   [§11-11「守り」3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1468)は、請求IDでファイルと患者マスタを消します。しかし[UKE保存](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/server/app/uke.ts:103)は複数請求を含むファイル単位で、[患者マスタ](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/server/app/patients.ts:89)は複数請求から共有されます。**患者A・Bを含むファイルからAの請求を削除すると、ファイルを消せばBも失われ、残せばAの原本が残ります。** 原本内の部分削除、共有患者の参照、キャッシュ失効まで削除仕様を決める必要があります。

3. **【high／設計】診療識別の区切りを、点数・回数の算定単位と取り違えている。**  
   [§11-14](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1568)の区切り方では、同じ診療識別内の複数単位を結合します。公式例には、診療識別12を最初だけ記録し、再診料76点と外来管理加算52点を別々の点数単位として並べる形があります。[公式手引き・本文30頁](https://www.hpdx.or.jp/seikyushiharai/iryokikan/iryokikan_02.files/jiki_i01.pdf#page=36)  
   **この例を読むと、未対応の外来管理加算に巻き込まれ、対応済みの再診料まで単位ごと対象外になります。** 点数単位とコメントの帰属を別に復元する必要があり、現在の[SIごとの読み取り](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/uke/uke.ts:270)からの変更契約も不足しています。

4. **【high／設計】UKEの点数欄と回数欄の意味が誤っている。**  
   [§11-14](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1568)は途中行の回数を空としていますが、仕様は同一単位内の各行に同じ回数を記録します。また、点数欄との照合に「区分の点数の合計×回数」を使うのも誤りです。[記録条件仕様・本文16頁](https://www.hpdx.or.jp/seikyushiharai/iryokikan/download/index.files/iryokikan_in_01.pdf#page=20)  
   **890点の訪問診療料を月2回算定した正常データは、点数欄890・回数2です。設計どおりなら1780と照合して拒否し、試算でも架空の差異を表示します。** 現行の[点数照合](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/uke/uke.ts:277)が分けている「1回分の点数」と「請求合計」を維持する必要があります。

5. **【medium／設計】対象外の単位があると、正しい訪問日の摘要を誤って不一致にする。**  
   [§11-13](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1550)は管理料コメントの訪問日を算定行と照合する一方、R17の`absenceFindings`を空にしています。しかし[§11-14](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1571)では、未対応コードを含む単位から対応済みの訪問行も除外されます。**11月5日・19日の訪問単位が未対応加算のため除外され、管理料と正しい日付コメントだけ残ると、照合対象の日付が消えて`comment_mismatch`になります。** この照合は「行がないこと」に依存します。必要な訪問行の完全性が分からない場合は、その照合を情報不足にする必要があります。
