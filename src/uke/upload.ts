// 取り込んだ UKE の請求 id は、アプリが振る（design.md §11-11・C-94）：U<取り込みの連番>-<ファイルの中の通し番号>（例 U12-3）。
// UKE の「カルテ番号等」の欄（RE の項目 14）は患者ごとの番号で、空でもよく、同じ患者の別の月・同じファイルの 2 枚目で重なる。
// だから請求 id にも重複の検査にも使わず、患者の番号として表示にだけ使う（UkeReceipt.patientNo）。
// 読み書きの本体（src/uke/uke.ts）は、請求 id の決め方を引数で受ける
import type { ClaimIdOf } from "./uke";

/** 取り込んだ請求の id。seq は取り込みの連番（クリニックごとに 1 から。消したファイルの番号は使い回さない）、n はファイルの中の通し番号（1 から） */
export const uploadClaimId = (seq: number, n: number): string => `U${seq}-${n}`;

/** その取り込みの連番のファイルの、請求 id の決め方（readUke・readStoredUke に渡す） */
export const uploadClaimIdOf = (seq: number): ClaimIdOf => (_, n) => uploadClaimId(seq, n);
