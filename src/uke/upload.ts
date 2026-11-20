// 取り込んだ UKE の請求 id は、アプリが振る（design.md §11-11・C-94）：U<取り込みの連番>-<ファイルの中の通し番号>（例 U12-3）。
// UKE の「カルテ番号等」の欄（RE の 13 列目）は患者ごとの番号で、空でもよく、同じ患者の別の月・同じファイルの 2 枚目で重なる。
// だから請求 id にも重複の検査にも使わず、患者の番号として表示にだけ使う。
//
// 読み書きの本体（src/uke/uke.ts）は、この欄を請求 id として読み、文字種と重複を確かめる。本体には手を入れず、
// 読む前に、この欄をアプリの振った id に置き換えたバイト列を作って渡す（Shift_JIS では、カンマと CRLF は文字の 2 バイト目に現れないので、バイトのまま区切れる）
import { UKE_LIMITS } from "./limits";
import type { UkeFile } from "./types";
import { readUke, UkeError } from "./uke";

/** 取り込んだ請求の id。seq は取り込みの連番（クリニックごとに 1 から。消したファイルの番号は使い回さない）、n はファイルの中の通し番号（1 から） */
export const uploadClaimId = (seq: number, n: number): string => `U${seq}-${n}`;

/**
 * 取り込んだ UKE を読む。請求 id は uploadClaimId(seq, 通し番号)。patientNos は、レセプトごとの「カルテ番号等」の欄（空のこともある。表示にだけ使う）。
 * 形式の検査は今までどおり readUke が行い、受け取れない入力は行番号つきの UkeError になる（行は増減しないので、行番号は元のファイルのまま）
 */
export function readUploadedUke(buf: Buffer, seq: number): { file: UkeFile; patientNos: string[] } {
  if (buf.length > UKE_LIMITS.maxBytes) throw new UkeError(null, "ファイルが大きすぎる");
  const patientNos: string[] = [];
  const lines = buf
    .toString("latin1")
    .split("\r\n")
    .map((l, i) => {
      if (!l.startsWith("RE,")) return l;
      const c = l.split(",");
      // 列数の足りない RE は、そのまま渡して readUke に断らせる
      if (c.length < 13) return l;
      let no = "";
      try {
        no = new TextDecoder("shift_jis", { fatal: true }).decode(Buffer.from(c[12], "latin1"));
      } catch {
        throw new UkeError(null, "Shift_JIS として読めない");
      }
      // 置き換える欄は readUke の目に入らなくなるので、同じ検査をここでしておく
      if (/[\u0000-\u001f\u007f]/.test(no)) throw new UkeError(i + 1, "制御文字がある");
      if (no.length > UKE_LIMITS.maxFieldLength) throw new UkeError(i + 1, "項目が長すぎる");
      patientNos.push(no);
      c[12] = uploadClaimId(seq, patientNos.length);
      return c.join(",");
    });
  return { file: readUke(Buffer.from(lines.join("\r\n"), "latin1")), patientNos };
}
