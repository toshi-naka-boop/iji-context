// 区分→架空の 9 桁レセ電コードの明示の表（design.md §2-6）。実在のマスターとは無関係（README に「架空コード」と明記する）
// 点数表は見ない。行は追記だけ（変える・消す・並べ替えると tests/engine/codes.lock.json との照合で落ちる）。
// コードは "99" ＋ 7 桁で、行の順に厳密に増える。廃止した区分の行も残す

export const CODE_TABLE: readonly { kubun: string; code: string }[] = [
  { kubun: "C001_1I", code: "990000001" },
  { kubun: "C001_1RO", code: "990000002" },
  { kubun: "C001_N13_DX", code: "990000003" },
  { kubun: "C001_N6_TERMINAL", code: "990000004" },
  { kubun: "C001_N7_MITORI", code: "990000005" },
  { kubun: "C001_N8_SHIBOU", code: "990000006" },
  { kubun: "C000", code: "990000007" },
  { kubun: "C000_N1_KINKYU", code: "990000008" },
  { kubun: "C002_2I1", code: "990000009" },
  { kubun: "C002_2RO1", code: "990000010" },
  { kubun: "C002_2NI1", code: "990000011" },
  { kubun: "C002_N4_IKOU", code: "990000012" },
  { kubun: "C002_N5_HINKAI1", code: "990000013" },
  { kubun: "C002_N5_HINKAI2", code: "990000014" },
  { kubun: "C002_N10_HOKATSU", code: "990000015" },
  { kubun: "C002_N15_RENKEI", code: "990000016" },
  { kubun: "C002_N2", code: "990000017" },
  { kubun: "C101_2I", code: "990000018" },
  { kubun: "C153_2", code: "990000019" },
  { kubun: "C103_2", code: "990000020" },
  { kubun: "C158", code: "990000021" },
  { kubun: "C157_1", code: "990000022" },
  { kubun: "F400_3", code: "990000023" },
  { kubun: "F400_2", code: "990000024" },
  { kubun: "F400_N4", code: "990000025" },
  { kubun: "F400_N6_1", code: "990000026" },
  { kubun: "D400_1", code: "990000027" },
  { kubun: "D005_5", code: "990000028" },
  { kubun: "D005_9", code: "990000029" },
  { kubun: "D007_10", code: "990000030" },
  { kubun: "D008_18", code: "990000031" },
  { kubun: "D026_3", code: "990000032" },
  { kubun: "D026_4", code: "990000033" },
  { kubun: "D026_5", code: "990000034" },
  { kubun: "D_GAIRAI_JINSOKU", code: "990000035" },
  { kubun: "O100_3I", code: "990000036" },
  { kubun: "O100_3RO", code: "990000037" },
  { kubun: "O100_SAISHIN", code: "990000038" },
  { kubun: "B000", code: "990000039" },
  { kubun: "A_IRYOJOHO", code: "990000040" },
  { kubun: "A_DXSUISHIN", code: "990000041" },
  // 令和8年度改定で足した区分（2026-11）。これより上の行は変えない
  { kubun: "D008_19", code: "990000042" },
  { kubun: "O001_3I", code: "990000043" },
  { kubun: "O001_3RO", code: "990000044" },
  { kubun: "O001_2", code: "990000045" },
  { kubun: "O001_1", code: "990000046" },
  { kubun: "O100_1HA", code: "990000047" },
  { kubun: "O100_1RO", code: "990000048" },
  { kubun: "O100_1I", code: "990000049" },
  { kubun: "C001_N13_DX2", code: "990000050" },
  { kubun: "A_DENSHI_RENKEI", code: "990000051" },
  { kubun: "C002-2_2I1", code: "990000052" },
  { kubun: "C002-2_2RO1", code: "990000053" },
  { kubun: "C002-2_2NI1", code: "990000054" },
  { kubun: "A001", code: "990000055" },
];

const CODE_OF = new Map(CODE_TABLE.map((r) => [r.kubun, r.code]));
const KUBUN_OF = new Map(CODE_TABLE.map((r) => [r.code, r.kubun]));

/** 区分が表にあるか（知識の match の区分の検査に使う。design.md §3） */
export const isKnownKubun = (kubun: string): boolean => CODE_OF.has(kubun);

/** 区分の架空コード。表にない区分は例外 */
export function fictionalCode(kubun: string): string {
  const code = CODE_OF.get(kubun);
  if (!code) throw new Error(`未知の区分: ${kubun}`);
  return code;
}

/** 架空コードの区分。表にないコードは例外 */
export function kubunOfCode(code: string): string {
  const kubun = KUBUN_OF.get(code);
  if (!kubun) throw new Error(`未知のコード: ${code}`);
  return kubun;
}
