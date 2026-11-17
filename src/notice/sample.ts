// 同梱の合成の査定通知（K6 の前月分の増減点連絡書。spec FR-79、design.md §3）。ファイル名の年月は基準月から作る
import { monthFrom } from "../demo/period";

/** 通知の診療年月（基準月の前の月） */
export const SAMPLE_NOTICE_MONTH = monthFrom(-1);
/** 拡張子を除いた置き場所（.html・.pdf・.json の 3 つがある） */
export const SAMPLE_NOTICE_BASE = `fixtures/notices/K6-${SAMPLE_NOTICE_MONTH}-satei`;
/** 知識の出典に書くファイル名 */
export const SAMPLE_NOTICE_PDF = `K6-${SAMPLE_NOTICE_MONTH}-satei.pdf`;
