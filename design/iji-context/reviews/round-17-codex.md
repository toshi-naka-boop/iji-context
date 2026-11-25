critic: codex/gpt-6.1-sol xhigh（read-only、15 分上限内に完走、175,106 tokens）

# round-17 クロスベンダー批評（v22）

解決済み項目を除き、重大度順に5件です。

1. **重大／設計：施設総管への注16の準用を落としている。**  
   [設計の在医総管限定](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:160)は、[現行EMの準用規定](/Users/toshixa/Documents/iji-context/design/iji-context/sources/evidence-master-iji-context.md:128)と矛盾します。K4相当の非重症患者・月2回訪問で `note16Met=false` にすると、D03は施設総管2ロ・2,585点を導出し、R01も通します。EMに従う2ニ・1,625点は逆に誤り扱いとなり、960点の過大算定を正解にします。R03・R14等の準用範囲も再反映が必要です。

2. **重大／前提：R10が「1回の診療」と「同じ日」を混同している。**  
   [R10の一律禁止](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:150)とD01・D02の二者択一は、[EM #7-8](/Users/toshixa/Documents/iji-context/design/iji-context/sources/evidence-master-iji-context.md:57)の区別・例外を取り込んでいません。文書提供済みの在支診患者に朝の定期訪問と夜の別の緊急往診があった場合も、一律に要件不足として片方を外させます。EMが示す同日例外の解釈は確度「中」なので、まず採否を確定し、同一診療の背反と同日・翌日の制限を分ける必要があります。

3. **重大／設計：新しいK6に旧来の「コメントを付ければ通る」が残っている。**  
   [§3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:406)と完了条件#10は、コメントだけでBNPのavoid／allowを切り替えます。しかし、新しいK6の条件は「心不全の疑いのまま連月算定」で、`Match` は疑い／確定を表現できません。疑い病名を変えずコメントだけ追加すると、旧allow知識が当たり、助言や適用記録が誤ります。既存の `matchApprox`・`conditionNote` を新K6に適用し、旧筋書きと受入条件を置き換える指定が必要です。

4. **重大／設計：`officialDate` の最大時刻だけでは、新しい公的文書を検出できない。**  
   [snapshotの定義](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:570)では、矛盾する文書Aと議題作成後に追加された文書Bの `registeredAt` が同じなら、最大値が変わりません。日付単位で進むデモ時計では同時刻の登録が起こり得ます。Bを提示していない古い回答1が通り、再承認後は登録時刻の条件からBのトリガーも発火しません。#11の「新文書追加後はstale」を満たすには、文書ID集合や内容ハッシュを照合対象にする必要があります。

5. **中／設計：版ファイルの必須データが年月検査で必ず落ちる。**  
   [Revisionの定義](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:219)は、`src/engine/revisions/` に `effectiveFrom: "2026-06"` 等を持たせます。一方、[完了条件#21](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:769)は `src app scripts` 全体の年月一致を0件と要求しています。この文字列は指定正規表現に一致するため、設計どおり実装しても移行の段2を完了できません。版データと業務年月の直書きを区別する検査仕様が必要です。


