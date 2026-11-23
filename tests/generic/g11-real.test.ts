// 実データ（masters.db）で確かめる、段 18b の完了条件（design.md §15-8・§15-10）：症例 K8〜K11 の取り忘れ（G11）。
// データは同梱しないので、環境変数 RESEMEN_MASTER_DIR（masters.db のあるフォルダ）があるときだけ動く。ないときは飛ばし、飛ばした数を表示する（黙って通さない）。
// 段の報告に出す数は console.log に出す。段 18c に頼らない（round-53 C-273）：取り込んだ請求でも g11Owned の区分は見ず、手書きのルールは R18 だけ
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateG11, NO_STRUCTURED_SCOPE, type G11About, type G11Claim, type G11Finding, type G11Result } from "../../src/generic/g11";
import { claimOfLines } from "../../src/generic/overlap";
import { g11Owned } from "../../src/engine/derive";
import { kubunOfCode } from "../../src/engine/revisions/codes";
import { openMasters, type MastersDb } from "../../src/masters/db";
import { loadCase } from "../engine/helpers";
import { aboutOf, actsOf, emptyDeclaration, G11_CASES, rev, ukeClaimOf, without } from "./g11-helpers";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
let skipped = 0;
const withData = (name: string, fn: () => void) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn);
};
afterAll(() => {
  if (!has) process.stderr.write(`段 18b の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
});

const run = (claim: G11Claim, about: G11About): Extract<G11Result, { findings: unknown }> => {
  const db = openMasters(file)!;
  try {
    const r = evaluateG11(claim, db, about, rev);
    if ("skip" in r) throw new Error(r.skip);
    return r;
  } finally {
    db.close();
  }
};
const keys = (fs: G11Finding[]) => fs.map((f) => `${f.messageKey} ${f.codes.join("+")} ${f.days.map((d) => d.date.slice(8)).join(",")}${f.caution ? " 注意つき" : ""}`);
/**
 * 正しい請求でも出る注意つき：K9 の中心静脈注射だけ（医療事務の答えが要る例外 HX-21 が決まらないため。C-280 の直し。2026-11-23 利用者の判断）。
 * 例外が全部 分類ア の K10 の酸素吸入は、言い切りの形として隠れる
 */
const CONDITIONAL: Record<string, string[]> = { K8: [], K9: ["G11.missing 130004410 28 注意つき"], K10: [], K11: [] };
/** 例外を名指しした K9 の中心静脈注射の添え書き（EM §2-12 HX-21 の一言） */
const K9_NOTE = "在宅中心静脈栄養法指導管理料を算定する月は、原則として算定できません。例外：医療型短期入所サービス費等を算定している短期入所中の患者に行ったもの。当たらなければ、請求にないままで合っています";
const owned = new Set(g11Owned(rev.consts));
/** 症例の「出るべき」行為のコード（請求の診療行為・医薬品のうち、版の区分の行と g11Owned でないもの） */
const shouldCodes = (k: string): string[] => {
  const base = new Set(loadCase(k).lines.map((l) => rev.codes[l.kubun].primary));
  return [...new Set(ukeClaimOf(k).units.flatMap((u) => u.items.map((it) => it.code)))].filter((c) => !base.has(c) && !owned.has(kubunOfCode(rev, c) ?? ""));
};

describe("段 18b：実データの masters.db で G11（K8〜K11）", () => {
  withData("正しい請求（torikawasure.UKE）で、添え書きのない指摘が 0 件。注意つきは K9 の中心静脈注射 1 件だけで、例外（医療型短期入所中）を名指しする。K8 の創傷処置・湿布、K10 の酸素吸入と酸素、K11 の院内の投薬は言わなかった一覧に並ぶ", () => {
    for (const k of G11_CASES) {
      const r = run(ukeClaimOf(k), aboutOf(k));
      expect([k, keys(r.findings)]).toEqual([k, CONDITIONAL[k]]);
      expect([k, r.findings.filter((f) => !f.caution).length]).toEqual([k, 0]);
      expect(r.findings.every((f) => f.certainty === "条件つき" && !/点|円/.test(f.text.replace(/時点|点検/g, "")))).toBe(true);
      console.log(`${k} 正しい請求：取り出した ${r.counts.acts}・当てられない ${r.counts.unmatched}・見ない ${r.counts.notSeen}・言わない ${JSON.stringify(r.counts.hidden)}・注意つき ${JSON.stringify(r.counts.caution)}・指摘 ${JSON.stringify(r.counts.byKind)}`);
    }
    const k8 = run(ukeClaimOf("K8"), aboutOf("K8")).hidden.map((h) => `${h.written} ${h.date.slice(8)} ${h.reason}`);
    expect(k8).toEqual(expect.arrayContaining(["創傷処置（１００ｃｍ２未満） 14 包括", "消炎鎮痛等処置（湿布処置） 28 包括"]));
    const k9 = run(ukeClaimOf("K9"), aboutOf("K9"));
    expect(k9.findings[0].days[0].notes).toEqual([{ reason: "データの点検の条件つきの違反", text: K9_NOTE }]);
    // K10 の酸素吸入と酸素（手技と薬の組）は、背反（例外は入院中の患者だけ）で組ごと隠れ、言わなかった一覧に組で並ぶ
    const k10 = run(ukeClaimOf("K10"), aboutOf("K10")).hidden.filter((h) => h.reason === "背反");
    expect(k10.map((h) => [h.written, h.date.slice(8), h.partner, h.with])).toEqual([["酸素吸入", "28", "在宅酸素療法指導管理料（その他）", ["液体酸素・可搬式液化酸素容器（ＬＧＣ）", expect.any(String)]]]);
    // K11 の院内の投薬・処方料・麻薬等加算・処方箋料も言わなかった一覧に並ぶ（包括）
    const k11 = run(ukeClaimOf("K11"), aboutOf("K11")).hidden.map((h) => `${h.written} ${h.reason}`);
    for (const w of ["アローゼン顆粒", "ハルシオン０．２５ｍｇ錠", "処方料（その他）", "麻薬等加算（処方料）", "処方箋料"]) expect(k11.some((h) => h.startsWith(w) && h.endsWith("包括"))).toBe(true);
  });

  withData("「出るべき」行為を 1 つずつ請求から外すと、外した単位のコードだけが出る（親が残れば子は missing_with）。同じ区分番号の別コードが残る外し方を含む", () => {
    const report: string[] = [];
    for (const k of G11_CASES) {
      const codes = shouldCodes(k);
      for (const code of codes) {
        const r = run(without(ukeClaimOf(k), code), aboutOf(k));
        // 外した行為の相手で隠れていた対照（K10 の酸素吸入など）は、候補どうしの背反の注意つきで出る（手順 2）ので除く
        const got = r.findings.filter((f) => !CONDITIONAL[k].includes(keys([f])[0]) && !(f.caution && !f.codes.includes(code)));
        expect([k, code, got.map((f) => f.codes.join("+"))]).toEqual([k, code, [code]]);
        expect([k, code, got[0].messageKey]).toEqual([k, code, ["620008991", "641140046", "621128301", "647130028", "646320003", "643230027", "643230038", "622345201", "643180017", "643140004", "620717601", "643330011", "647250002", "620007260", "620002613"].includes(code) ? "G11.missing_with" : "G11.missing"]);
        report.push(`${k}:${code}`);
      }
    }
    // 明示して含める外し方（C-220・X-132）
    expect(report).toEqual(expect.arrayContaining(["K8:114001470", "K9:160061810", "K9:160031710", "K9:160072370"]));
    console.log(`1 つずつ外した請求：${report.length} 通り`);
  });

  withData("名称どおりの合成カルテと略した書き方の合成カルテで、正しい請求と 1 つずつ外した請求の G11 の結果（コードと日）が同じ（段 18a の報告の残り）", () => {
    const codeDays = (fs: G11Finding[]) => fs.map((f) => `${f.codes.join("+")} ${f.days.map((d) => d.date).join(",")}`).sort();
    for (const k of G11_CASES) {
      // 略した書き方の合成カルテには判断料を置いていないので、判断料は決まった規則で足す候補（missing_derived）になる。コードと日だけを比べる
      for (const code of [null, ...shouldCodes(k)]) {
        const claim = code ? without(ukeClaimOf(k), code) : ukeClaimOf(k);
        // X23 の皮内、皮下及び筋肉内注射は、略した書き方では行為に立てていない（EM §5-1-2）
        if (k === "K8" && code === "130000510") continue;
        const a = codeDays(run(claim, aboutOf(k)).findings);
        const b = codeDays(run(claim, aboutOf(k, { abbrev: true })).findings);
        expect([k, code, b]).toEqual([k, code, a]);
      }
    }
  });

  withData("K11 の X51・X52・X54 は、dispensing のどれでも出ない。分からないでは点検の範囲に案内が出る。院内の日は「算定できない見込み（包括）」で、言わなかった一覧に組が並ぶ（M-3 の例 3・L-96）", () => {
    for (const dispensing of ["inside", "outside", "unknown"] as const) {
      const r = run(ukeClaimOf("K11"), aboutOf("K11", { dispensing }));
      expect([dispensing, keys(r.findings)]).toEqual([dispensing, []]);
      if (dispensing === "unknown") expect(r.scope.some((s) => s.startsWith("院内か院外かが分からないので薬は見ていません"))).toBe(true);
      if (dispensing === "inside") {
        const h = r.hidden.filter((x) => x.date === "2026-10-14").map((x) => `${x.written} ${x.reason}`);
        for (const w of ["アローゼン顆粒", "ハルシオン０．２５ｍｇ錠", "処方料（その他）", "麻薬等加算（処方料）"]) expect(h).toContain(`${w} 包括`);
        expect(r.guide).toBeNull();
      }
    }
  });

  withData("K11 X27 の薬だけを外すと、dispensing のどれでも missing_with。関節腔内注射と薬を組ごと外すと、在医総管の月でも 130005310 が missing（調剤料・処方料は足さない。C-213）", () => {
    for (const dispensing of ["inside", "outside", "unknown"] as const) {
      const r = run(without(without(ukeClaimOf("K11"), "620007260"), "620002613"), aboutOf("K11", { dispensing }));
      expect([dispensing, keys(r.findings)]).toEqual([dispensing, ["G11.missing_with 620002613 14", "G11.missing_with 620007260 14"]]);
      const all = run(without(without(without(ukeClaimOf("K11"), "620007260"), "620002613"), "130005310"), aboutOf("K11", { dispensing }));
      expect([dispensing, keys(all.findings)]).toEqual([dispensing, ["G11.missing 130005310 14"]]);
    }
  });

  withData("K8 の患家診療時間加算を請求に残したまま、爪甲除去術を外すと missing（添え書きなし。X-136）", () => {
    const r = run(without(ukeClaimOf("K8"), "150054110"), aboutOf("K8"));
    expect(keys(r.findings)).toEqual(["G11.missing 150054110 14"]);
    expect(r.findings[0].days[0].notes).toEqual([]);
  });

  withData("算定プレビュー（導出の算定行）で、g11Owned の区分の G11 が 0 件（FR-99）。D09・D10 の区分は導出の行があれば言わない", () => {
    for (const k of G11_CASES) {
      const claim = claimOfLines(loadCase(k).lines, rev).claim;
      const r = run(claim, aboutOf(k, { path: "preview" }));
      expect(r.findings.filter((f) => f.codes.some((c) => owned.has(kubunOfCode(rev, c) ?? "")))).toEqual([]);
      expect(r.counts.notSeen).toBeGreaterThan(0);
    }
  });

  withData("申告が空の実在用のクリニック（どの申告も分からない）でも、1 つずつ外した行為が missing で出る。K8〜K11 の行為に施設基準の要るものがない（数を報告）", () => {
    const db = openMasters(file)!;
    const snap = db.prepare("SELECT snapshot FROM sources WHERE tbl = 'shinryo' ORDER BY snapshot DESC").get() as { snapshot: string };
    let need = 0;
    for (const k of G11_CASES)
      for (const code of shouldCodes(k)) {
        const r = db.prepare("SELECT shisetsu_g1, shisetsu_g2, shisetsu_g3 FROM shinryo WHERE snapshot = ? AND code = ?").get(snap.snapshot, code) as { shisetsu_g1: string; shisetsu_g2: string; shisetsu_g3: string } | undefined;
        if (r && [r.shisetsu_g1, r.shisetsu_g2, r.shisetsu_g3].some((v) => v !== "0" && v !== "")) need++;
      }
    db.close();
    for (const k of G11_CASES)
      for (const code of shouldCodes(k)) {
        const r = run(without(ukeClaimOf(k), code), aboutOf(k, { declaration: emptyDeclaration() }));
        expect([k, code, r.findings.filter((f) => !CONDITIONAL[k].includes(keys([f])[0]) && !(f.caution && !f.codes.includes(code))).map((f) => f.codes.join("+"))]).toEqual([k, code, [code]]);
      }
    console.log(`K8〜K11 の「出るべき」行為のうち施設基準の要るもの：${need}（作り物のマスターで別に確かめる）`);
    expect(need).toBe(0);
  });

  withData("K10 で X39 と X32 の両方が請求にないとき、X39 は添え書きなしで、X32 は「（これも取り忘れの候補）」の添え書きつきの注意つきで後ろに出る。並べ方を逆にしても同じ（X-140）", () => {
    const claim = without(without(ukeClaimOf("K10"), "114003710"), "114006110");
    const about = aboutOf("K10");
    const r = run(claim, about);
    expect(keys(r.findings)).toEqual(["G11.missing 114003710 14", "G11.missing 114006110 14", "G11.missing 140005610 28 注意つき"]);
    expect(r.findings[2].days[0].notes.map((n) => n.text)).toContain("『在宅酸素療法指導管理料（その他）』（これも取り忘れの候補）を算定すると、背反で算定できません。どちらを算定するか確かめてください");
    const rev2 = run(claim, { ...about, acts: [...about.acts!].reverse() });
    expect(rev2.findings).toEqual(r.findings);
  });

  withData("K9 で判断料の名前をカルテから消しても、血液学的検査判断料を請求から外すと missing_derived。カルテに判断料があれば missing だけ（X-147）", () => {
    const about = aboutOf("K9");
    const noJudge = { ...about, acts: about.acts!.filter((a) => !a.act.written.includes("判断料")) };
    const r = run(without(ukeClaimOf("K9"), "160061810"), noJudge);
    expect(keys(r.findings).filter((x) => !CONDITIONAL.K9.includes(x))).toEqual(["G11.missing_derived 160061810 14"]);
    expect(r.findings[0].text).toContain("マスターの検査のグループから決まる項目です");
    const both = run(without(ukeClaimOf("K9"), "160061810"), about);
    expect(keys(both.findings).filter((x) => !CONDITIONAL.K9.includes(x))).toEqual(["G11.missing 160061810 14"]);
  });

  withData("量（X-144・C-262）：K8 の患家診療時間加算で、70分は同じなので出ず、80分なら quantity_less。1回は回数の規則に回り、1 日の上限の行がなければ比べない。1時間10分は比べず数に出る", () => {
    const withQty = (q: string) => {
      const about = aboutOf("K8");
      return { ...about, acts: about.acts!.map((a) => (a.act.match?.code === "114001470" ? { ...a, act: { ...a.act, quantity: q } } : a)) };
    };
    expect(keys(run(ukeClaimOf("K8"), withQty("70分")).findings)).toEqual([]);
    const r80 = run(ukeClaimOf("K8"), withQty("80分"));
    expect(keys(r80.findings)).toEqual(["G11.quantity_less 114001470 14"]);
    expect(r80.findings[0].text).toBe("カルテ（14日）では『患家診療時間加算（在宅患者訪問診療料（１）・（２））』が80分、請求では70です。算定できるか確かめてください");
    const r1 = run(ukeClaimOf("K8"), withQty("1回"));
    expect(keys(r1.findings)).toEqual([]);
    expect(r1.scope).toContain("量は見ていません（1 日の回数の決まりがデータにない）：1 件");
    const rh = run(ukeClaimOf("K8"), withQty("1時間10分"));
    expect(keys(rh.findings)).toEqual([]);
    expect(rh.scope).toContain("量は見ていません（決まった形で書かれていない）：1 件");
  });

  withData("子の量（X-145・C-262）：ゲーベンクリームの 20g は ｇ と NFKC で同じなので比べ、請求の使用量が 10 なら子の quantity_less、20 なら出ない。グラム・mL は単位がマスターと合わない", () => {
    const claim10: G11Claim = { units: ukeClaimOf("K8").units.map((u) => ({ ...u, items: u.items.map((it) => (it.code === "620008991" ? { ...it, quantity: "10" } : it)), days: u.items.some((it) => it.code === "620008991") ? u.days.map((n, i) => (i === 13 ? n : 0)) : u.days })) };
    // 28 日の分は 20 のまま（14 日だけ 10 にする）
    claim10.units.push({ items: [{ kind: "SI", code: "140032110" }, { kind: "IY", code: "620008991", quantity: "20" }], count: 1, days: Array.from({ length: 31 }, (_, i) => (i === 27 ? 1 : 0)) });
    const r = run(claim10, aboutOf("K8"));
    expect(keys(r.findings)).toEqual(["G11.quantity_less 620008991 14"]);
    expect(r.findings[0].text).toBe("カルテ（14日）では「熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）」で使った「ゲーベンクリーム１％」が20g、請求では10です。算定できるか確かめてください");
    for (const q of ["20グラム", "20mL"]) {
      const about = aboutOf("K8");
      const a2 = { ...about, acts: about.acts!.map((a) => ({ ...a, act: { ...a.act, with: a.act.with?.map((c) => (c.match?.code === "620008991" ? { ...c, quantity: q } : c)) } })) };
      const rq = run(claim10, a2);
      expect([q, keys(rq.findings)]).toEqual([q, []]);
      expect(rq.scope).toContain("量は見ていません（単位がマスターと合わない（マスターは ｇ））：2 件");
    }
  });

  withData("約束 3 つ（15-8）：K8〜K11 の 1 つずつ外す請求で、出した候補に言い切りの形の抑えがなく、隠した候補には抑えがあり、結果は並べ方を逆にしても同じ", () => {
    for (const k of G11_CASES)
      for (const code of [null, ...shouldCodes(k)]) {
        const claim = code ? without(ukeClaimOf(k), code) : ukeClaimOf(k);
        const about = aboutOf(k);
        const a = run(claim, about);
        const b = run(claim, { ...about, acts: [...about.acts!].reverse(), rxDays: [...about.rxDays!].reverse() });
        expect([k, code, b.findings, b.hidden]).toEqual([k, code, a.findings, a.hidden]);
        // (2) 隠した候補には抑えの理由と相手がある
        expect(a.hidden.every((h) => h.reason !== "" && h.partner !== "")).toBe(true);
      }
  });
});

/** 段の報告：K8〜K11 の G11 の数を、1 つずつ外した請求の全部について数える */
describe("段 18b の報告の数", () => {
  withData("1 つずつ外した請求の G11 の数（指摘の種類ごと・言わない理由ごと・注意つきの理由ごと）", () => {
    const sum: Record<string, number> = {};
    const bump = (k: string, n = 1) => (sum[k] = (sum[k] ?? 0) + n);
    let db: MastersDb | null = null;
    try {
      db = openMasters(file)!;
      for (const k of G11_CASES) {
        const { acts } = actsOf(k);
        bump("取り出した（行為）", acts.length);
        for (const code of shouldCodes(k)) {
          const r = evaluateG11(without(ukeClaimOf(k), code), db, aboutOf(k), rev);
          if ("skip" in r) throw new Error(r.skip);
          for (const [x, n] of Object.entries(r.counts.byKind)) bump(`指摘 ${x}`, n);
          for (const [x, n] of Object.entries(r.counts.hidden)) bump(`言わない ${x}`, n);
          for (const [x, n] of Object.entries(r.counts.caution)) bump(`注意つき ${x}`, n ?? 0);
          bump("見ない", r.counts.notSeen);
          bump("当てられない", r.counts.unmatched);
        }
      }
    } finally {
      db?.close();
    }
    console.log(`段 18b の G11 の数（K8〜K11 の 1 つずつ外した請求の合計）：${JSON.stringify(sum)}`);
    expect(sum["当てられない"]).toBe(0);
  });
});

describe("v34（design.md §16-4-1。C-433）：構造化データのない取り込んだ請求", () => {
  withData("K8〜K11 の取り込んだ請求（構造化データなし）で、点検の範囲に「電子カルテの構造化データがないので…見ていません」が 1 行だけ出て、規則の候補（指摘）は増えない", () => {
    for (const k of G11_CASES) {
      const r = run(ukeClaimOf(k), aboutOf(k));
      expect(r.scope.filter((s) => s === NO_STRUCTURED_SCOPE)).toHaveLength(1);
      expect(r.findings.filter((f) => f.messageKey === "G11.missing_rule")).toEqual([]);
    }
  });
});
