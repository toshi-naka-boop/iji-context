critic: codex/gpt-6.1-sol xhigh だけ（design-critic は省略。理由：追加分の 3 巡目で、round-26 の改訂の確認に絞ったため）

tokens used
89,384
1. **【high】請求 id が衝突し、別患者の請求を混同する。**  
   [§11-11](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1482)の「SHA-256 の先頭8桁＋通し番号」では一意になりません。

   **破綻例：** 現行パーサを通る、患者名が異なる合成UKEをメモリ上で2本作成し、ハッシュが `e21b127aa1e3…` と `e21b127ae1b7…` になる組を再現しました。全文のハッシュは異なるため両方受け入れますが、先頭の請求 id は両方 `Ue21b127a-1` になります。[caseOf](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/server/app/cases.ts:102)は最初の一致を返すため、後から取り込んだ患者を開いても先の患者の請求を返します。請求 id にひもづく記録の参照・削除も区別できません。

   ファイルごとに一意な内部 id を採番・保存し、請求の通し番号と組み合わせる必要があります。
