critic: codex/gpt-6.1-sol xhigh（round-80。対象 design.md §18-12・sources/em-v38-draft.md）

1. **X-370｜high｜実装 — 過去月の「認定なし」が、後の月の認定を上書きする。**  
   [facts.ts:144](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/patient/facts.ts:144) は対象月で選ぶ前に最終登録行を採用します。11月から有効な要介護3を登録後、10月の「認定なし」を回答すると、11月の値が **3→0** になり、正しい包括的支援加算に `R03.not_eligible` が出ることを再現しました。§18-12(1)には、期間付き認定と6か月の推定期間が重なる場合の優先規則が必要です。

2. **X-371｜high｜設計 — 看取り・死亡診断の導出元 D11 が修正対象から漏れている。**  
   [設計:3373](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3373) は R09・D12 を挙げていますが、この2加算を生成するのは [D11](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/engine/derive.ts:457) です。(Ⅰ)2だけの入力で死亡診断を選ぶと、禁止された `C001_N8_SHIBOU` が残りました。総額は保留でも、加算行は生成されます。D11を対応表・承認前保留に追加する必要があります。根拠：[告示 C001注7・8、p138](https://www.mhlw.go.jp/content/12400000/001686842.pdf#page=138)。:codex-file-citation{path="/private/tmp/claude-501/-Users-toshixa-Documents-iji-context/2b55f9e0-1fbd-45be-a64c-446b804ed7ab/scratchpad/gigi14/001686842.txt" purpose="source"}

3. **X-372｜high｜設計 — D01の保留が、依存する管理料・加算に伝わらない。**  
   [設計:3371–3376](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3371) は「D03は今のまま」と「D01は保留」の接続を規定していません。現実装は、仮生成した(Ⅰ)1からD03・D04を作った後、[末尾でD01だけを除去](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/engine/derive.ts:490)します。訪問イベント1件＋同日の(Ⅰ)2で、在医総管・包括的支援加算が `tentative:false` のまま残ることを再現しました。総額は保留です。確定できた(Ⅰ)1だけで依存先を再計算する規則が必要です。

4. **X-373｜mid｜設計 — D12に不要な「同日」の制約を加えている。**  
   [EM案:81](/Users/toshixa/Documents/iji-context/design/iji-context/sources/em-v38-draft.md:81) の「(Ⅰ)1の日にだけ立てる」は、算定区分の制限を日付一致へ強めています。10/8に(Ⅰ)1、10/22に往診・死亡という、台帳で維持したK5系まで排除します。[留意 C000(12)、p246](https://www.mhlw.go.jp/content/12400000/001757385.pdf#page=246) の死亡前15日間の扱いを保ち、付加先の区分と算定日を分けて記述すべきです。:codex-file-citation{path="/private/tmp/claude-501/-Users-toshixa-Documents-iji-context/2b55f9e0-1fbd-45be-a64c-446b804ed7ab/scratchpad/gigi14/001757385.pdf" purpose="source"}

5. **X-374｜mid｜設計 — R11が承認前保留から漏れ、未確認が正常通過に見える。**  
   [EM案:65](/Users/toshixa/Documents/iji-context/design/iji-context/sources/em-v38-draft.md:65) はR11を「数える・確度中」とする一方、[設計:3376](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3376) の保留一覧にはありません。(Ⅰ)2＋外来迅速検体検査加算、当日説明・文書提供が不明の入力で、**R11は適用済み・指摘0件**を再現しました。承認前は「見ていない」と明示し、承認後は日付判定と `reads` の両方に(Ⅰ)2を追加する必要があります。
