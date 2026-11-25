critic: codex/gpt-6.1-sol xhigh

**high は1件です。**

1. **X-360｜high｜設計：利用前30日の探索から在がん総診が抜けている。**  
   [§18-3②](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3294) の探索対象は訪問診療料・在医総管・施医総管ですが、[EM R8-248](/Users/toshixa/Documents/iji-context/design/iji-context/sources/em-v37-draft.md:65) は在がん総診も含みます。9/25に患家で訪問して在がん総診を算定し、10/10から小多機へ宿泊した患者では、必要月を取り込んでも「利用前算定なし」となり、正しい10/11の訪問を誤指摘します。

2. **X-361｜mid｜設計：C-501の受理が完了条件に反映されていない。**  
   [②の本文](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3292) は自宅患者の小多機宿泊月を「R16が確定で見る」と修正済みですが、[③](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3296) と[完了条件6](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3342) は宿泊月に一律で黙る記述です。受理済みの判断に沿った実装が、完了条件では不合格になります。抑止条件を本文・導出D03・完了条件で統一する必要があります。

3. **X-362｜mid｜設計：同月に複数回ある短期入所を表現できない。**  
   [入れ物](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3268) は患者×項目×月に単一の種類・期間・利用先を持ちます。10/1〜5と10/20〜24に利用し、10/10は自宅で訪問した場合、期間をまとめれば10/10を誤指摘し、片方だけ保存すれば他方を見逃します。複数期間を保持するか、この場合を未判定にする規定が必要です。

4. **X-363｜mid｜設計：小多機・看多機の「施設の医師」の除外が未定義。**  
   [EM R8-248](/Users/toshixa/Documents/iji-context/design/iji-context/sources/em-v37-draft.md:65) は施設の医師を除外しますが、[宿泊の判定](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3295) にはその分岐がありません。前後30日の条件を満たす施設医師の算定を見逃します。短期入所生活介護に追加した配置医師の設定で判断できるのかも、明示が必要です。

5. **X-364｜mid｜設計：退院日開始の新しい分岐が30日上限まで止め得る。**  
   [「はい」なら退院日の算定日だけを候補にする記述](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3295) を分岐全体に適用すると、9/20に退院して宿泊開始した非末期患者の10/25の訪問を見逃します。[EM R8-248](/Users/toshixa/Documents/iji-context/design/iji-context/sources/em-v37-draft.md:65) では、この例外でも30日上限は残ります。免除するのは利用前算定の条件だけ、と適用範囲を限定すべきです。
