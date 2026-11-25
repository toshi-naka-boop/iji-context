// 版が持つ診療行為コード（design.md §11-1・§11-8 完了条件 1）：evidence-master §2-8「採用した診療行為コード」の表との突き合わせと、コードの表の検査
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRevisions, isKnownKubun, REVISIONS } from "../../src/engine/revisions";
import { assertCodes, bundleKubun, bundleOfCode, bundleOfKubun, codeOf, kubunOfCode } from "../../src/engine/revisions/codes";
import { r2026 } from "../../src/engine/revisions/r2026";
import type { Revision } from "../../src/engine/revisions/types";

const repo = path.join(__dirname, "..", "..");

/** EM §2-8 の節（見出しから次の見出しまで）。なければ例外（表のない EM では、版にコードを置けない） */
function emSection(): string {
  const em = readFileSync(path.join(repo, "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8");
  const start = em.indexOf("### 2-8. 採用した診療行為コード");
  if (start < 0) throw new Error("evidence-master に「2-8. 採用した診療行為コード」の節がない");
  const end = em.indexOf("\n### ", start + 1);
  return em.slice(start, end < 0 ? undefined : end);
}
const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
const num = (s: string) => Number(s.replaceAll(",", ""));

/** points は EM の「マスターの点数」。点数識別 3 でない行（注8 の減算の「20（点数識別 6）」）は null */
type EmRow = { primary: string; accept: string[]; points: number | null; shikibetsu: string };
/** 区分 → コードの表（コードが 9 桁の行だけ。包括の検査の行は下の表で読む） */
const emCodes = new Map<string, EmRow>(
  emSection()
    .split("\n")
    .map(cells)
    .filter((c) => c.length === 8 && /^\d{9}$/.test(c[1]))
    .map((c) => {
      // 診療識別の列は「14（手引き p65）」か「未確認（集計先 140）」。後者は集計先の上 2 桁を使う
      const shikibetsu = /^(\d{2})（/.exec(c[5])?.[1] ?? /^未確認（集計先 (\d{2})\d）$/.exec(c[5])?.[1];
      if (!shikibetsu) throw new Error(`EM §2-8 の診療識別の列を読めない: ${c[0]}`);
      return [c[0], { primary: c[1], accept: c[2] === "—" ? [] : c[2].split("・"), points: /^[\d,]+$/.test(c[4]) ? num(c[4]) : null, shikibetsu }];
    }),
);
/** 包括の区分 → 点数（「生化学的検査(Ⅰ) の包括」の表と、「G・H のコード」の D008・D013 の表。design.md §19-1） */
const emTiers = new Map(
  emSection()
    .split("\n")
    .map(cells)
    .filter((c) => c.length === 5 && /^D0(07|08|13)_\d+$/.test(c[0]))
    .map((c) => [c[0], num(c[2])]),
);
/** EM §2-8「G・H のコード」の項目の一覧（D008・D013。design.md §19-1） */
const emGroup = (name: string): string[] => {
  const line = emSection().split("\n").find((l) => l.startsWith(`- ${name} `) && l.includes("の包括の項目"));
  if (!line) throw new Error(`EM §2-8 に ${name} の項目の一覧がない`);
  return line.slice(line.lastIndexOf("：") + 1).split("・");
};
/** 包括の対象のコード → マスターの名称（3 組が横に並ぶ表） */
const emMembers = new Map(
  emSection()
    .split("\n")
    .map(cells)
    .filter((c) => c.length === 9 && /^\d+$/.test(c[0]))
    .flatMap((c) => [[c[1], c[2]], [c[4], c[5]], [c[7], c[8]]] as [string, string][])
    .filter(([code]) => /^\d{9}$/.test(code)),
);

describe("evidence-master §2-8 との対応（完了条件 1）", () => {
  // コードの表は 189 行：版の表の 48 行と、実務の算定 A で採った施設基準の 45 行（2026-11-22。段 17d で版に入れた。spec FR-189）、
  // 単一建物 2 人以上の区分の 96 行（EM R8-95〜R8-190。段 17f で §2-8-2 から §2-8 へ移し、版に入れた）、注14 の減の行の 90 行（段 17h で同じく移した。W-13＝E-10）、
  // 介護保険・ほかの医療機関との調整の 4 行（C001_2I・C001_2RO・C007・C010。2026-11-24 の EM の写し。設計 v37 §18-4）
  // 包括の区分は、D007 の 3 行と、v44 で足した D008・D013 の 6 行（design.md §19-1）
  it("EM の表が読めている（コードの表 283 行・包括の区分 9 行・D007 の包括の対象 66 コード・D008 79 コード・D013 20 コード）", () => {
    expect(emCodes.size).toBe(283);
    expect([...emTiers.keys()].sort()).toEqual(["D007_10", "D007_5", "D007_8", "D008_3", "D008_6", "D008_8", "D013_3", "D013_4", "D013_5"]);
    expect(emMembers.size).toBe(66);
    expect(new Set(emGroup("D008")).size).toBe(79);
    expect(new Set(emGroup("D013")).size).toBe(20);
  });

  it("どの版でも、codes の全行（primary・accept）が EM の表にある。facility は accept の 1 つ。診療識別は EM の列と同じ", () => {
    for (const rev of REVISIONS) {
      for (const [kubun, def] of Object.entries(rev.codes)) {
        const row = emCodes.get(kubun);
        expect(row, `${rev.id} ${kubun}`).toBeDefined();
        expect(def.primary, `${rev.id} ${kubun}`).toBe(row!.primary);
        expect([...def.accept].sort(), `${rev.id} ${kubun}`).toEqual([...row!.accept].sort());
        if (def.facility !== undefined) expect(row!.accept, `${rev.id} ${kubun}`).toContain(def.facility);
        expect(rev.shikibetsu[kubun], `${rev.id} ${kubun}`).toBe(row!.shikibetsu);
      }
    }
  });

  it("kind が「改定」の版では、EM の「マスターの点数」と点数表の点数が一致する（値の変更の版は、その時点のマスターがないので比べない）", () => {
    const revised = REVISIONS.filter((r) => r.kind === "改定");
    expect(revised.length).toBeGreaterThan(0);
    for (const rev of revised) {
      for (const kubun of Object.keys(rev.codes)) expect(rev.points[kubun].points, `${rev.id} ${kubun}`).toBe(emCodes.get(kubun)!.points);
      for (const b of rev.bundles) for (const t of b.tiers) expect(rev.points[t.kubun].points, `${rev.id} ${t.kubun}`).toBe(emTiers.get(t.kubun));
    }
  });

  // v44（design.md §19-1）で、D007 の members を 66 個全部にし（尿・髄液・胸水・腹水の版の 18 個も項目数に合わせる。C-601・X-440）、D013 の群を足した。
  // v45（design.md §19-13 の 1）で D008 の群を足した。BNP（160162350）は codes の D008_19 と D008 の群の両方にある（EM §2-8 DUP-01 の sharedCodes だけ）
  it("bundles の members は EM の包括の対象の表のコードを、群ごとに全部持つ（D007 は 66 個、D008 は 79 個、D013 は 20 個）。D013 は血液だけを数える群", () => {
    for (const rev of REVISIONS.filter((r) => r.bundles.length > 0)) {
      expect(rev.bundles.map((b) => b.tiers[0].kubun.split("_")[0]), rev.id).toEqual(["D007", "D008", "D013"]);
      const [d007, d008, d013] = rev.bundles;
      expect([...d008.members].sort(), rev.id).toEqual([...emGroup("D008")].sort());
      expect(d008.tiers).toEqual([
        { min: 3, kubun: "D008_3" },
        { min: 6, kubun: "D008_6" },
        { min: 8, kubun: "D008_8" },
      ]);
      expect(d008.bloodOnly).toBeUndefined();
      expect(rev.sharedCodes).toEqual(["160162350"]);
      expect(kubunOfCode(rev, "160162350")).toBe("D008_19");
      expect(bundleOfCode(rev, "160162350")).toBe(d008);
      expect([...d007.members].sort(), rev.id).toEqual([...emMembers.keys()].sort());
      expect(d007.tiers).toEqual([
        { min: 5, kubun: "D007_5" },
        { min: 8, kubun: "D007_8" },
        { min: 10, kubun: "D007_10" },
      ]);
      expect(d007.bloodOnly).toBeUndefined();
      expect([...d013.members].sort(), rev.id).toEqual([...emGroup("D013")].sort());
      expect(d013.tiers).toEqual([
        { min: 3, kubun: "D013_3" },
        { min: 4, kubun: "D013_4" },
        { min: 5, kubun: "D013_5" },
      ]);
      expect(d013.bloodOnly).toBe(true);
      for (const bundle of rev.bundles) for (const t of bundle.tiers) expect(rev.shikibetsu[t.kubun]).toBe("60");
    }
  });

  it("点数表の各区分が、codes・bundles・uncoded のちょうど 1 つにある", () => {
    for (const rev of REVISIONS) {
      for (const kubun of Object.keys(rev.points)) {
        const n = [Object.hasOwn(rev.codes, kubun), rev.bundles.some((b) => b.tiers.some((t) => t.kubun === kubun)), Object.hasOwn(rev.uncoded, kubun)].filter(Boolean).length;
        expect(n, `${rev.id} ${kubun}`).toBe(1);
      }
    }
  });
});

describe("コードの表の検査（assertRevisions）", () => {
  const withCodes = (over: Partial<Pick<Revision, "codes" | "bundles" | "uncoded" | "shikibetsu" | "points" | "sharedCodes">>): Revision => ({ ...r2026, ...over });
  const code = (kubun: string) => r2026.codes[kubun];

  it("同梱の版は通る", () => {
    expect(() => assertRevisions(REVISIONS)).not.toThrow();
  });

  it("9 桁の数字でないコードは拒否する", () => {
    for (const bad of ["11400111", "1140011100", "11400111a", ""]) {
      expect(() => assertCodes(withCodes({ codes: { ...r2026.codes, C000: { primary: bad, accept: [] } } }))).toThrow(/9 桁/);
    }
  });

  it("codes と bundles の両方に置けるのは sharedCodes（EM §2-8 DUP-01）のコードだけ。ほかのコードは今までどおり拒否する", () => {
    expect(() => assertCodes(withCodes({}))).not.toThrow();
    expect(() => assertCodes(withCodes({ sharedCodes: [] }))).toThrow(/同じコードが 2 か所/);
  });

  it("同じコードが 2 つの区分に現れる版は拒否する（primary と accept を合わせて。bundles の members とも重ならない）", () => {
    expect(() => assertCodes(withCodes({ codes: { ...r2026.codes, C000: { primary: code("A001").primary, accept: [] } } }))).toThrow(/同じコードが 2 か所/);
    expect(() => assertCodes(withCodes({ codes: { ...r2026.codes, C000: { ...code("C000"), accept: [code("F400_2").accept[0]] } } }))).toThrow(/同じコードが 2 か所/);
    expect(() => assertCodes(withCodes({ codes: { ...r2026.codes, C000: { primary: r2026.bundles[0].members[0], accept: [] } } }))).toThrow(/同じコードが 2 か所/);
    const twice = { ...r2026.bundles[0], members: [...r2026.bundles[0].members, r2026.bundles[0].members[0]] };
    expect(() => assertCodes(withCodes({ bundles: [twice] }))).toThrow(/同じコードが 2 か所/);
  });

  it("点数表の区分が、どこにもない・2 か所以上にある版は拒否する", () => {
    const { C158: _, ...rest } = r2026.codes;
    expect(() => assertCodes(withCodes({ codes: rest }))).toThrow(/どこにもない: C158/);
    expect(() => assertCodes(withCodes({ uncoded: { C158: "理由" } }))).toThrow(/2 か所以上にある: C158/);
    expect(() => assertCodes(withCodes({ uncoded: { D007_10: "理由" } }))).toThrow(/2 か所以上にある: D007_10/);
    // コードを外して uncoded に載せれば通る
    expect(() => assertCodes(withCodes({ codes: rest, uncoded: { C158: "コードが 1 つに決まらない" } }))).not.toThrow();
  });

  it("点数表にない区分のコード・診療識別のない区分・accept にない facility は拒否する", () => {
    expect(() => assertCodes(withCodes({ codes: { ...r2026.codes, XXXX: { primary: "100000001", accept: [] } } }))).toThrow(/点数表にない区分: XXXX/);
    const { C000: _, ...shikibetsu } = r2026.shikibetsu;
    expect(() => assertCodes(withCodes({ shikibetsu }))).toThrow(/診療識別がない: C000/);
    expect(() => assertCodes(withCodes({ codes: { ...r2026.codes, C000: { ...code("C000"), facility: "100000001" } } }))).toThrow(/facility/);
  });
});

describe("コードの引き方（版を決めてから）", () => {
  it("primary も accept も同じ区分に引ける。表にないコードは null", () => {
    for (const rev of REVISIONS) {
      for (const [kubun, def] of Object.entries(rev.codes)) for (const c of [def.primary, ...def.accept]) expect(kubunOfCode(rev, c), `${rev.id} ${c}`).toBe(kubun);
      for (const bad of ["100000001", "11400111", ""]) expect(kubunOfCode(rev, bad)).toBeNull();
      // 包括の検査の項目は、区分 1 つには引けない（項目数で決まる）
      expect(kubunOfCode(rev, rev.bundles[0].members[0])).toBeNull();
      expect(bundleOfCode(rev, rev.bundles[0].members[0])).toBe(rev.bundles[0]);
      expect(bundleOfCode(rev, rev.codes.C000.primary)).toBeNull();
    }
  });

  it("同じコードでも、版が違えば別の区分に引ける（版を決めない逆引きは持たない）", () => {
    const bnp = r2026.codes.D008_19.primary;
    const other: Revision = { ...r2026, id: "other", codes: { D008_18: { primary: bnp, accept: [] } } };
    expect(kubunOfCode(r2026, bnp)).toBe("D008_19");
    expect(kubunOfCode(other, bnp)).toBe("D008_18");
  });

  it("書き出しのコードは primary。施設に入居する患者の在宅ターミナルケア加算だけ、ロのコードになる", () => {
    expect(codeOf(r2026, "C001_N6_TERMINAL")).toBe("114018370");
    expect(codeOf(r2026, "C001_N6_TERMINAL", true)).toBe("114042570");
    expect(codeOf(r2026, "C000", true)).toBe(r2026.codes.C000.primary);
    // 包括の検査の区分・その版にない区分は、コード 1 つでは書けない
    expect(() => codeOf(r2026, "D007_10")).toThrow(/コードのない区分/);
    expect(() => codeOf(r2026, "XXXX")).toThrow(/コードのない区分/);
  });

  it("包括の検査は項目数で区分が決まる（4 項目以下はどの区分でもない）", () => {
    const b = r2026.bundles[0];
    expect([4, 5, 7, 8, 9, 10, 48].map((n) => bundleKubun(b, n))).toEqual([null, "D007_5", "D007_5", "D007_8", "D007_8", "D007_10", "D007_10"]);
    expect(bundleOfKubun(r2026, "D007_8")).toMatchObject({ min: 8, max: 9 });
    expect(bundleOfKubun(r2026, "D007_10")).toMatchObject({ min: 10, max: Number.POSITIVE_INFINITY });
    expect(bundleOfKubun(r2026, "C000")).toBeNull();
  });

  it("isKnownKubun は、同梱のどれかの版の点数表にある区分だけを通す", () => {
    expect(isKnownKubun("D008_19")).toBe(true);
    expect(isKnownKubun("D007_5")).toBe(true);
    expect(isKnownKubun("XXXX")).toBe(false);
    expect(isKnownKubun("toString")).toBe(false);
  });
});
