codex: gpt-6.1-sol（reasoning effort xhigh）。codex exec --sandbox read-only。§15 を対象に round-42

解決済みの論点を除き、以下の5件です。

1. **〔設計／high〕調剤料への包括指摘が、薬の取り忘れを抑止できない**  
   [§15-8](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2199)は「足した行為のコード」に当たる指摘だけで抑止します。しかし投薬では、薬と一緒に足した調剤料のコードに包括指摘が出ます。  
   **破綻例：** K11・X51の内服薬を照合すると、調剤料は包括で止まっても、薬のコードには指摘が当たらず、薬を取り忘れとして出してしまいます。[EMの採用値](/Users/toshixa/Documents/iji-context/design/iji-context/sources/evidence-master-iji-context.md:1646)とFR-194に反します。薬と補助行を一組として抑止する必要があります。

2. **〔設計／high〕依存する点検の未実行を、指摘なしと区別していない**  
   [§15-8](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2199)には、再実行するG03〜G06・G10が `notReady`／`skip` だった場合の保留条件がありません。「指摘が出なかった」だけでは算定不能を除外できません。  
   **破綻例：** 基本マスターは読めるが包括テーブルの取り込みに失敗した環境で、K8の創傷処置を照合すると、G04が動かず、包括される処置を取り忘れとして出します。G11に依存点検の準備条件を設け、未実行なら判定を保留すべきです。

3. **〔設計／high〕同じ区分番号の別コードが、独立した検査の欠落まで隠す**  
   [§15-8](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2198)の「同じ日に同じ区分番号の別コードがあれば言わない」は、代替関係のない項目にも適用されます。  
   **破綻例：** K9からTSHだけを外し、同じD008のFT4等を残すと、TSHの取り忘れが抑止されます。TSHは[EMで「出るべき」](/Users/toshixa/Documents/iji-context/design/iji-context/sources/evidence-master-iji-context.md:1623)とされ、段18bの単位削除試験にも通りません。抑止は、代替関係を確認できたコード間に限定する必要があります。

4. **〔設計／medium〕注5の申告から、請求コードの正しい側を検証する規則がない**  
   [§15-4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2131)のR18は種別を比較しますが、通常／注5の比較は担当していません。D07の導出を直すだけでは、既存請求の取り違えを検出できません。  
   **破綻例：** 4307・4303をともに「持つ」と申告した施設が通常の180725910を請求すると、G10は4307を満たして通し、注5の180854010への取り違えを誰も指摘しません。[EMのコード対応](/Users/toshixa/Documents/iji-context/design/iji-context/sources/evidence-master-iji-context.md:466)を使い、請求側でも `baseUp` と区分を比較する規則が必要です。

5. **〔設計／medium〕在支診か不明な場合のR10・D01への接続が未定義**  
   [§15-2](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2072)は `zaishishin` を三値にしますが、既存の[R10・D01の判定](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:320)は真偽値を前提としており、不明時の変更・受け入れ条件がありません。  
   **破綻例：** 種別申告が期限切れで、往診の翌日に訪問診療を算定し、文書提供は確認済みの場合。R18の対象行がなく、既存の真偽分岐に流れると、通過か要件不足になり、FR-190が要求する施設申告の情報不足を保証できません。R10の情報不足とD01の保留まで明記する必要があります。


