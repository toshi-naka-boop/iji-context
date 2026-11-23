// 令和8年度改定後の版の、摘要欄に要る記載（design.md §11-13）。値は evidence-master（EM）§2-10 表 1・表 1-a の行だけ。
// 表 2 の行（別表Ⅰ に定めがあるが、条件を決める事実をアプリが持たないもの）は入れない。コメント関連テーブルは写さない
import { bandRows } from "./r2026-band";
import type { CommentCodeNote, CommentRule } from "./types";

const em = (row: string) => `EM §2-10 表 1 ${row}`;

export const comments: CommentRule[] = [
  {
    id: "T176-date",
    kubun: ["C002_2I1", "C002_2RO1", "C002_2NI1", "C002-2_2I1", "C002-2_2RO1", "C002-2_2NI1"],
    codes: ["850100106", "850100107"],
    need: "any",
    when: "always",
    compare: "visitDates",
    summary: "その月に往診又は訪問診療を行った年月日（日ごとに 1 件）",
    em: em("T176-date"),
  },
  {
    id: "T178-state",
    kubun: ["C002_N10_HOKATSU"],
    codes: [
      "820100626", "820100627", "820100628", "820100629", "820100631", "820100632", "820100633", "820100634",
      "820100635", "820100636", "820100637", "820101318", "820100638", "820100639", "820100640", "820100641",
    ],
    need: "any",
    when: "always",
    compare: "hokatsuState",
    summary: "包括的支援加算の対象になる状態（要介護3 以上など、当たるものを選ぶ）",
    em: em("T178-state"),
  },
  {
    id: "T177-first",
    kubun: ["C002_N4_IKOU"],
    codes: ["850100108", "850100109"],
    need: "any",
    when: "always",
    compare: "ikouStart",
    summary: "初回の管理料を算定した年月日",
    em: em("T177-first"),
  },
  { id: "T169-death", kubun: ["C001_N6_TERMINAL"], codes: ["850100098"], need: "each", when: "always", compare: "deathDate", summary: "死亡年月日", em: em("T169-death") },
  {
    id: "T169-last24",
    kubun: ["C001_N6_TERMINAL"],
    codes: ["850100100", "851100038"],
    need: "each",
    when: "deathNotAtHome",
    summary: "死亡前 24 時間以内に行った訪問診療の年月日と時刻",
    em: em("T169-last24"),
  },
  { id: "T216-spo2", kubun: ["C103_2"], codes: ["842100072", "842100044"], need: "any", when: "always", summary: "その月の動脈血酸素分圧又は動脈血酸素飽和度", em: em("T216-spo2") },
  { id: "T162-reason", kubun: ["C000"], codes: ["830100086"], need: "each", when: "sameDayVisitAndOushin", summary: "訪問診療と同じ日に往診が必要になった理由（両方を算定した日ごとに 1 件）", em: em("T162-reason") },
  {
    id: "T167-acute",
    kubun: ["C001_1I", "C001_1RO"],
    codes: ["830100088", "850100094", "850100095"],
    need: "each",
    when: "acuteOver3PerWeek",
    compare: "acuteVisitDates",
    summary: "週 4 回以上の訪問診療の必要性、必要を認めた診療年月日、訪問診療を行った年月日（日ごとに 1 件）",
    em: em("T167-acute"),
  },
  // 単一建物 2 人以上の区分（EM R8-95〜R8-190 の 96 区分。段 17f）の行に、その人数（2026-11-23 承認）
  { id: "T176-band", kubun: bandRows.map((r) => r.kubun), codes: ["842100035", "842100036"], need: "any", when: "always", summary: "単一建物診療患者の人数（数字）", em: em("T176-band") },
];

export const commentCodes: Record<string, CommentCodeNote> = {
  // 在医総管の行に付けるコードと、施設総管の行に付けるコード（T176-date・T177-first）
  "850100106": { family: "在医総管" },
  "850100107": { family: "施設総管" },
  "850100108": { family: "在医総管" },
  "850100109": { family: "施設総管" },
  // 単一建物診療患者数（T176-band）
  "842100035": { family: "在医総管" },
  "842100036": { family: "施設総管" },
  // 包括的支援加算の状態のうち、確かめた事実と比べられるもの（表 1-a の「比べる」の行）
  "820100626": { careLevel: 3 },
  "820100627": { careLevel: 4 },
  "820100628": { careLevel: 5 },
  "820100629": { disabilityLevelMin: 2 },
  // 急性増悪の「訪問診療を行った年月日」
  "850100095": { visited: true },
};
