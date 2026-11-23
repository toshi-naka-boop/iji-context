// 摘要欄の記載の点検（R17。design.md §11-13 の完了条件 (a)〜(f)）と、導出の「摘要欄に書くこと」。
// (g) 問題の請求に R17 を掛けないことは tests/server/app.test.ts、(h) 知識の commentOn の当たり方は tests/lifecycle/match.test.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSources } from "../../scripts/gen-uke";
import { evaluate, rulesOf } from "../../src/engine";
import { commentFormatOk, dateOfWareki, requiredComments, warekiOf } from "../../src/engine/comments";
import { deriveLines, manualLinesOf } from "../../src/engine/derive";
import { REVISIONS, resolveRevision } from "../../src/engine/revisions";
import { r2026 } from "../../src/engine/revisions/r2026";
import type { ClaimContext, Comment, Finding } from "../../src/engine/types";
import { COMMENT_CHECK_NOTE, COMMENT_CHECK_SCOPE, findingText, FINDING_TEXT } from "../../src/messages";
import { claimPreviewOf } from "../../src/chart/claim";
import { commentsOfCase } from "../../src/uke/cases";
import { commentOf } from "../../src/uke/uke";
import { day, YM } from "../helpers/period";
import { loadCase, withFact } from "./helpers";

const repo = path.join(__dirname, "..", "..");
const REV = resolveRevision(YM);
const em = readFileSync(path.join(repo, "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8");
const section = (() => {
  const start = em.indexOf("### 2-10. 摘要欄の記載");
  if (start < 0) throw new Error("evidence-master に「2-10. 摘要欄の記載」の節がない");
  return em.slice(start, em.indexOf("\n### ", start + 1));
})();
/** 節の中の、見出し（**表 n**・表 1-a）から次の見出しまでの表の行 */
const tableAfter = (head: string, until: string) => {
  const start = section.indexOf(head);
  const end = section.indexOf(until, start + head.length);
  if (start < 0 || end < 0) throw new Error(`EM §2-10 の表が見つからない: ${head}`);
  return section.slice(start, end).split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
};
const codesIn = (s: string) => s.match(/\d{9}/g) ?? [];
/** 表 1 の区分キーの欄の区分。「R8-95〜R8-190」の形は、EM §2-2 のその範囲の行の区分キー（T176-band） */
function kubunOfCell(cell: string): string[] {
  const range = /R8-(\d+)〜R8-(\d+)/.exec(cell);
  if (!range) return cell.match(/[A-Z]\d{3}(?:-\d)?(?:_[A-Z0-9]+)*/g) ?? [];
  const [from, to] = [Number(range[1]), Number(range[2])];
  return em.split("\n").flatMap((l) => {
    const c = l.split("|").slice(1, -1).map((x) => x.trim());
    const n = /^R8-(\d+)$/.exec(c[0] ?? "");
    return n && Number(n[1]) >= from && Number(n[1]) <= to ? [c[1]] : [];
  });
}

const { src } = loadSources();
/** 同梱の症例を、UKE から作った請求と同じ形（必須のコメントつき・commentsKnown が真）にする */
const ukeCase = (name: string): ClaimContext => {
  const c = loadCase(name);
  return { ...c, comments: commentsOfCase(c, src.commentValues?.[c.claimId]), commentsKnown: true };
};
/** 形式ごとの、点検を通る値の見本 */
const sample = (code: string) => ({ "820": "", "830": "理由の文", "842": "95", "850": warekiOf(day(1))!, "851": "0930" })[code.slice(0, 3)] ?? "";
/**
 * 行・事実・出来事に合う必須のコメントをすべて付けた請求にする。人が入れる記載（needsInput）には、形式の合う見本の値を入れる（コードを選ぶものは表の先頭のコード）。
 * 同じ日の往診の理由などで条件が変わっても、ここを通せば「記載はそろっている」状態になる
 */
const complete = (c: ClaimContext): ClaimContext => ({
  ...c,
  commentsKnown: true,
  comments: requiredComments(c, REV).map((r) => {
    const code = r.code ?? REV.comments.find((x) => x.id === r.rule)!.codes[0];
    return commentOf(code, r.text ?? sample(code), [r.kubun]);
  }),
});
const r17 = (c: ClaimContext) => evaluate(c).findings.filter((f) => f.ruleId === "R17");
const keyOf = (f: Finding) => f.messageKey.slice("R17.".length);
/** 「指摘の種類:どの記載か」か、情報不足なら「情報不足:足りない事実」 */
const tags = (c: ClaimContext) => r17(c).map((f) => (f.kind === "情報不足" ? `情報不足:${f.missing?.field}` : `${keyOf(f)}:${f.params?.rule}`));
const dropCode = (c: ClaimContext, code: string): ClaimContext => ({ ...c, comments: c.comments!.filter((x) => x.code !== code) });
const replaceText = (c: ClaimContext, code: string, text: string, nth = 0): ClaimContext => {
  let n = -1;
  return { ...c, comments: c.comments!.map((x): Comment => (x.code === code && ++n === nth ? { ...x, text, raw: text } : x)) };
};

/** 表 1 の行ごとに、その記載が要る請求（記載はそろっている） */
const K1 = ukeCase("K1");
const K2 = ukeCase("K2");
const K3 = ukeCase("K3");
const K4 = ukeCase("K4");
const K5 = ukeCase("K5");
/** 在宅以外で亡くなった */
const K5_HOSPITAL = complete(withFact(loadCase("K5"), "deathPlace", { known: true, value: "病院" }));
/** 訪問診療料と往診料の両方を算定した日が n 日（往診料の日に、訪問診療料の日を重ねる） */
const sameDays = (n: number): ClaimContext => {
  const c = loadCase("K5");
  const days = [day(22), day(23)].slice(0, n);
  return {
    ...c,
    lines: c.lines.map((l) => (l.kubun === "C001_1I" ? { ...l, count: l.count + n, dates: [...l.dates, ...days] } : l.kubun === "C000" ? { ...l, count: n, dates: days } : l)),
  };
};
/** 別表第七に当たらない患者が、急性増悪で週 4 回（基準月の 5〜8 日）訪問した */
const ACUTE = complete(withFact(withFact(loadCase("K3"), "table7", { known: true, value: false }), "acuteExacerbation", { known: true, value: true }));
const ACUTE_DAYS = [day(5), day(6), day(7), day(8)];
/** 管理料を単一建物 2〜9 人の区分にした K1（患者ごとの人数の区分は 2〜9 人と確かめた。段 17f） */
const BAND = complete({
  ...loadCase("K1"),
  lines: loadCase("K1").lines.map((l) => (l.kubun === "C002_2I1" ? { ...l, kubun: "C002_2I2" } : l)),
  facility: { ...loadCase("K1").facility, building: { known: true, value: "some" } },
  facts: { ...loadCase("K1").facts, buildingBand: { known: true, value: "2-9" } },
});
const HOLDS: Record<string, ClaimContext> = {
  "T176-date": K1,
  "T178-state": K2,
  "T177-first": K2,
  "T169-death": K5,
  "T169-last24": K5_HOSPITAL,
  "T216-spo2": K1,
  "T162-reason": complete(sameDays(1)),
  "T167-acute": ACUTE,
  "T176-band": BAND,
};

describe("evidence-master §2-10 との対応（完了条件 (a)）", () => {
  const rows = tableAfter("**表 1　点検する行", "注：").filter((c) => /^T\d+-/.test(c[0] ?? ""));

  it("表 1 の全行が版の comments にあり、その逆も成り立つ（id・区分・コメントコード・条件・数え方）", () => {
    // 段 17f で T176-band（単一建物 2 人以上の区分の人数）を表 1 に足して 9 行
    expect(rows).toHaveLength(9);
    for (const rev of REVISIONS) {
      expect(rev.comments.map((r) => r.id).sort(), rev.id).toEqual(rows.map((c) => c[0]).sort());
      for (const c of rows) {
        const rule = rev.comments.find((r) => r.id === c[0])!;
        expect([...rule.kubun].sort(), c[0]).toEqual(kubunOfCell(c[1]).sort());
        expect([...rule.codes].sort(), c[0]).toEqual(codesIn(c[3]).sort());
        const when = c[5].includes("在宅以外で死亡") ? "deathNotAtHome" : c[5].includes("同じ日に往診料") ? "sameDayVisitAndOushin" : c[5].includes("急性増悪") ? "acuteOver3PerWeek" : c[5] === "算定すれば必ず" || /（[^）]*の行を算定すれば必ず）$/.test(c[5]) ? "always" : "?";
        expect(rule.when, c[0]).toBe(when);
        // 「全部」と書いてある行は each、「どれか 1 つ」「族に合う」行は any。コードが 1 つの行は、どちらでも同じ
        if (rule.codes.length > 1) expect(rule.need, c[0]).toBe(c[4].startsWith("全部") ? "each" : "any");
        expect(rule.em, c[0]).toContain(c[0]);
        for (const k of rule.kubun) expect(Object.hasOwn(rev.points, k), `${rev.id} ${k}`).toBe(true);
      }
    }
  });

  it("表 1-a：包括的支援加算の 16 個のコードは T178-state の codes と同じ。事実と比べるのは「比べる」と書いてある 4 つだけ", () => {
    const state = tableAfter("表 1-a", "- 820100630").filter((c) => /^\d{9}$/.test(c[0] ?? ""));
    expect(state).toHaveLength(16);
    const rule = r2026.comments.find((r) => r.id === "T178-state")!;
    expect([...rule.codes].sort()).toEqual(state.map((c) => c[0]).sort());
    const compared = state.filter((c) => c[2].startsWith("比べる"));
    expect(compared.map((c) => [c[0], c[1]])).toEqual([
      ["820100626", "1-1 要介護3"],
      ["820100627", "1-2 要介護4"],
      ["820100628", "1-3 要介護5"],
      ["820100629", "1-4 障害支援区分2 以上"],
    ]);
    expect(Object.fromEntries(rule.codes.filter((c) => Object.hasOwn(r2026.commentCodes, c)).map((c) => [c, r2026.commentCodes[c]]))).toEqual({
      "820100626": { careLevel: 3 },
      "820100627": { careLevel: 4 },
      "820100628": { careLevel: 5 },
      "820100629": { disabilityLevelMin: 2 },
    });
  });

  it("コードの補足（族・訪問した日）は、表 1 のコードの欄の書き方と同じ。補足を持つコードは、どれも表 1 のコード", () => {
    const cell = (id: string) => rows.find((c) => c[0] === id)![3];
    const family = (id: string) => Object.fromEntries(codesIn(cell(id)).map((code) => [code, new RegExp(`${code}（在医総管`).test(cell(id)) ? "在医総管" : "施設総管"]));
    const want = { ...family("T176-date"), ...family("T177-first"), ...family("T176-band") };
    expect(Object.fromEntries(Object.entries(r2026.commentCodes).flatMap(([code, n]) => (n.family ? [[code, n.family]] : [])))).toEqual(want);
    expect(Object.values(want).sort()).toEqual(["在医総管", "在医総管", "在医総管", "施設総管", "施設総管", "施設総管"]);
    expect(cell("T167-acute")).toContain("850100095（訪問診療を行った年月日）");
    expect(Object.entries(r2026.commentCodes).filter(([, n]) => n.visited).map(([code]) => code)).toEqual(["850100095"]);
    const all = new Set(r2026.comments.flatMap((r) => r.codes));
    for (const code of Object.keys(r2026.commentCodes)) expect(all.has(code), code).toBe(true);
  });

  it("画面の説明：点検している項目は表 1 の行数、点検していない項目は表 2 の行数と表 1-b の項番の数（表 1-b は読むだけで、記載もれは点検しない）", () => {
    const unchecked = tableAfter("**表 2　別表Ⅰ に定めがあるが点検しない行", "- 別表Ⅰ に行がない区分").filter((c) => c.length === 5 && /項番\d+/.test(c[1]));
    // 表 1-b（材料加算の 2 回分・3 回分の対象の月。設計 v33 E-11 で表 2 から移した）は G11 が読むだけで、R17 は点検しない
    const readOnly = tableAfter("表 1-b", "**表 2").filter((c) => /^\d{9}$/.test(c[0] ?? ""));
    expect(readOnly.map((c) => c[0]).sort()).toEqual(["820100122", "820100123", "820100124", "820100125", "820100126"]);
    expect(COMMENT_CHECK_SCOPE.checked).toHaveLength(r2026.comments.length);
    expect(COMMENT_CHECK_SCOPE.uncheckedCount).toBe(unchecked.length + new Set(readOnly.map((c) => c[1])).size);
    expect(COMMENT_CHECK_NOTE).toContain("次の 9 項目");
    expect(COMMENT_CHECK_NOTE).toContain("18 件");
  });

  it("年号区分（表 3）：5＝令和。和暦 7 桁と西暦を行き来できる", () => {
    expect(section).toContain("**5＝令和**");
    expect(warekiOf(`${YM}-14`)).toBe(`5${String(Number(YM.slice(0, 4)) - 2018).padStart(2, "0")}${YM.slice(5)}14`);
    expect(dateOfWareki(warekiOf(day(14))!)).toBe(day(14));
    expect(dateOfWareki("4310430")).toBe(["2019", "04", "30"].join("-"));
  });

  it("値の変更の版は、摘要欄の記載の表を引き継ぐ", () => {
    for (const rev of REVISIONS) {
      expect(rev.comments).toBe(r2026.comments);
      expect(rev.commentCodes).toBe(r2026.commentCodes);
      expect(rev.rules.map((r) => r.id)).toContain("R17");
    }
  });
});

describe("記載もれ（完了条件 (b)）", () => {
  it("同梱の K1〜K7 を UKE と同じ必須のコメントつきにすると、R17 は当たり、指摘は 0 件。コメントを持たない請求（commentsKnown が偽）には当たらない", () => {
    for (const name of ["K1", "K2", "K3", "K4", "K5", "K7"]) {
      const r = evaluate(ukeCase(name));
      expect(r.applied, name).toContain("R17");
      expect(r.findings.filter((f) => f.ruleId === "R17"), name).toEqual([]);
      // 同じコメントを持っていても、commentsKnown が偽なら見ない（指摘も情報不足も返さない）
      const off = evaluate({ ...ukeCase(name), comments: [], commentsKnown: false });
      expect(off.applied, name).not.toContain("R17");
      expect(off.findings.filter((f) => f.ruleId === "R17"), name).toEqual([]);
    }
    // 必須の記載のある区分がない請求（K6）には当たらない
    expect(evaluate(ukeCase("K6")).applied).not.toContain("R17");
  });

  it.each(r2026.comments.map((r) => [r.id]))("%s：記載がそろっていれば指摘なし。要るコードのコメントを消すと、その記載の comment_missing が 1 件だけ出る", (id) => {
    const rule = REV.comments.find((r) => r.id === id)!;
    const c = HOLDS[id];
    expect(tags(c)).toEqual([]);
    const needed = rule.codes.filter((code) => c.comments!.some((x) => x.code === code));
    expect(needed.length).toBeGreaterThan(0);
    // 「どれか 1 つ」の記載は、使っているコードを消す。「全部」の記載は、どの 1 つを消しても出る
    for (const code of needed) {
      const found = r17(dropCode(c, code));
      expect(found.map((f) => `${keyOf(f)}:${f.params?.rule}`), code).toEqual([`comment_missing:${id}`]);
      expect(found[0]).toMatchObject({ kind: "記載もれ", lineRefs: rule.kubun.filter((k) => c.lines.some((l) => l.kubun === k)), params: { what: rule.summary } });
      expect(findingText(found[0])).toContain(rule.summary);
    }
  });

  it("置き場所では判定しない：コメントがどの区分にも付いていなくても（on が空）、コードがあれば記載はある", () => {
    for (const c of [K1, K2, K3, K5]) expect(tags({ ...c, comments: c.comments!.map((x) => ({ ...x, on: [] })) })).toEqual([]);
  });

  it("管理料の族に合うコードを求める：施設総管の行に、在医総管用のコードのコメントしかなければ記載もれ", () => {
    expect(K4.comments!.map((x) => x.code)).toEqual(["850100107", "850100107"]);
    expect(tags({ ...K4, comments: K4.comments!.map((x) => ({ ...x, code: "850100106" })) })).toEqual(["comment_missing:T176-date"]);
    expect(tags({ ...K2, comments: K2.comments!.map((x) => (x.code === "850100108" ? { ...x, code: "850100109" } : x)) })).toEqual(["comment_missing:T177-first"]);
  });

  it("「どれか 1 つ」の記載は、表のほかのコードでもよい（動脈血酸素分圧・包括的支援加算のほかの状態）", () => {
    expect(tags({ ...K1, comments: K1.comments!.map((x) => (x.code === "842100044" ? { ...x, code: "842100072" } : x)) })).toEqual([]);
    expect(tags({ ...K2, comments: K2.comments!.map((x) => (x.code === "820100626" ? { ...x, code: "820100635" } : x)) })).toEqual([]);
  });
});

describe("形式（完了条件 (c)）", () => {
  it("UKE に全角で書いた年月日・数値は、半角に寄せて読むので形式違いにならない", () => {
    // 同梱の UKE（全角で記録）を読んだ請求は tests/uke/uke.test.ts が 0 件と確かめている。ここは、原文が全角で、半角に寄せた値を持つコメントを直接見る
    expect(K1.comments!.find((x) => x.code === "850100106")).toMatchObject({ raw: expect.stringMatching(/^[０-９]{7}$/), text: expect.stringMatching(/^\d{7}$/) });
    expect(K1.comments!.find((x) => x.code === "842100044")).toMatchObject({ raw: "９５", text: "95" });
    expect(tags(K1)).toEqual([]);
    for (const ok of ["95", "95.5", "-1.5", "+2"]) expect(tags(replaceText(K1, "842100044", ok)), ok).toEqual([]);
  });

  it("壊れた年月日・数値でない値・空の文字は comment_format（その記載の突き合わせはしない）", () => {
    for (const bad of ["5081340", "5081032", "508101", "50810144", "9081014", "5001014", "", "令和8年10月14日"]) {
      expect(tags(replaceText(K1, "850100106", bad)), bad).toEqual(["comment_format:T176-date"]);
    }
    for (const bad of ["", "九十五", "95%", "9 5", "."]) expect(tags(replaceText(K1, "842100044", bad)), bad).toEqual(["comment_format:T216-spo2"]);
    expect(tags(replaceText(HOLDS["T162-reason"], "830100086", "　"))).toEqual(["comment_format:T162-reason"]);
    for (const bad of ["2460", "930", "09:30"]) expect(tags(replaceText(K5_HOSPITAL, "851100038", bad)), bad).toEqual(["comment_format:T169-last24"]);
    expect(r17(replaceText(K1, "850100106", "5081340"))[0]).toMatchObject({ kind: "記載もれ", lineRefs: ["C002_2I1"] });
  });

  it("形式はコードの先頭 3 桁で決まる（EM §2-10 表 3 のうち、表 1 のコードが使う形式）", () => {
    expect([commentFormatOk("820100626", ""), commentFormatOk("830100086", "理由"), commentFormatOk("842100044", "95"), commentFormatOk("850100106", warekiOf(day(1))!), commentFormatOk("851100038", "2359")]).toEqual([true, true, true, true, true]);
    expect([commentFormatOk("830100086", ""), commentFormatOk("842100044", "x"), commentFormatOk("850100106", "0930"), commentFormatOk("851100038", "5081014")]).toEqual([false, false, false, false]);
    // 表 1 のコードの形式は、この 5 つだけ
    expect([...new Set(r2026.comments.flatMap((r) => r.codes).map((c) => c.slice(0, 3)))].sort()).toEqual(["820", "830", "842", "850", "851"]);
  });
});

describe("中身の突き合わせ（完了条件 (d)）", () => {
  it("visitDates：往診・訪問診療の年月日の記載が、訪問診療料・往診料の算定日と合わなければ指摘。足りない日・多い日を出す", () => {
    const wrong = replaceText(K1, "850100106", warekiOf(day(15))!);
    expect(r17(wrong)).toEqual([expect.objectContaining({ kind: "記載もれ", messageKey: "R17.comment_mismatch_visitDates", lineRefs: ["C002_2I1"], params: expect.objectContaining({ rule: "T176-date", lacking: day(14), extra: day(15) }) })]);
    expect(findingText(r17(wrong)[0])).toMatch(/記載のない日：\d+\/14。算定のない日：\d+\/15）$/);
    // 1 日分だけ消すと、数は足りている（1 件以上）が、日が足りない
    const one: ClaimContext = { ...K1, comments: K1.comments!.filter((x) => !(x.code === "850100106" && x.text === warekiOf(day(28)))) };
    expect(r17(one).map((f) => [keyOf(f), f.params?.lacking, f.params?.extra])).toEqual([["comment_mismatch_visitDates", day(28), undefined]]);
    // 往診料だけの日も、記載が要る
    const withOushin: ClaimContext = { ...K1, lines: [...K1.lines, { kubun: "C000", count: 1, dates: [day(20)] }] };
    expect(r17(withOushin).map((f) => [keyOf(f), f.params?.lacking])).toEqual([["comment_mismatch_visitDates", day(20)]]);
  });

  it("hokatsuState：要介護度・障害支援区分と食い違う状態のコードは指摘。事実が不明なら比べない。対応を持たないコードは比べない", () => {
    const withCode = (code: string, c: ClaimContext = K2): ClaimContext => ({ ...c, comments: c.comments!.map((x) => (x.code === "820100626" ? { ...x, code } : x)) });
    const care = (n: number) => withFact(K2, "careLevel", { known: true, value: n });
    expect(tags(care(2))).toEqual(["comment_mismatch_hokatsuState:T178-state"]);
    expect(tags(care(4))).toEqual(["comment_mismatch_hokatsuState:T178-state"]);
    expect(tags(withCode("820100627", care(4)))).toEqual([]);
    expect(tags(withFact(K2, "careLevel", { known: false }))).toEqual([]);
    expect(tags(withCode("820100629", withFact(K2, "disabilitySupportLevel", { known: true, value: 1 })))).toEqual(["comment_mismatch_hokatsuState:T178-state"]);
    expect(tags(withCode("820100629", withFact(K2, "disabilitySupportLevel", { known: true, value: 2 })))).toEqual([]);
    expect(tags(withCode("820100629"))).toEqual([]);
    expect(tags(withCode("820100635", care(2)))).toEqual([]);
  });

  it("deathDate：死亡年月日の記載が死亡の記録の日と違えば指摘。カルテ側の記録がない請求では比べない", () => {
    const wrong = replaceText(K5, "850100098", warekiOf(day(21))!);
    expect(tags(wrong)).toEqual(["comment_mismatch_deathDate:T169-death"]);
    const noRecords: ClaimContext = { ...wrong, events: [], recordsKnown: false };
    expect(tags(noRecords)).toEqual(["情報不足:chartRecord"]);
    // 記録はあるが死亡の出来事がない請求では、「なかった」と読む（指摘になる）。この種類だけが、出来事を読む指摘として申告されている
    expect(tags({ ...K5, events: K5.events.filter((e) => e.type !== "death") })).toEqual(["comment_mismatch_deathDate:T169-death"]);
    expect(rulesOf(YM).find((r) => r.id === "R17")!.recordFindings).toEqual(["comment_mismatch_deathDate"]);
  });

  it("ikouStart：初回の管理料を算定した年月日の月が、算定開始月と違えば指摘。算定開始月の記録がなければ比べない", () => {
    const start = K2.events.find((e) => e.type === "kanriStart")!;
    const wrong = replaceText(K2, "850100108", warekiOf(day(1))!);
    expect(start).toMatchObject({ month: expect.not.stringMatching(YM) });
    expect(tags(wrong)).toEqual(["comment_mismatch_ikouStart:T177-first"]);
    // 同じ月の中なら、日が違っても指摘しない（記録が持つのは月まで）
    expect(tags(replaceText(K2, "850100108", `${K2.comments!.find((x) => x.code === "850100108")!.text.slice(0, 5)}01`))).toEqual([]);
    expect(r17({ ...wrong, events: wrong.events.filter((e) => e.type !== "kanriStart") }).map(keyOf).filter((k) => k.startsWith("comment_"))).toEqual([]);
  });

  it("指摘の文言は、どの種類にもある。点数は書かない", () => {
    for (const k of ["comment_missing", "comment_format", "comment_mismatch_visitDates", "comment_mismatch_acuteVisitDates", "comment_mismatch_deathDate", "comment_mismatch_hokatsuState", "comment_mismatch_ikouStart"]) {
      expect(FINDING_TEXT[`R17.${k}`], k).toBeTruthy();
      expect(FINDING_TEXT[`R17.${k}`], k).not.toMatch(/[0-9０-９]\s*点/);
    }
  });
});

describe("訪問診療と同じ日の往診の理由（完了条件 (e)）", () => {
  it("両方を算定した日が 2 日で、理由が 1 つなら comment_missing。2 つなら出ない。同じ日がなければ求めない", () => {
    const two = complete(sameDays(2));
    expect(two.comments!.filter((x) => x.code === "830100086")).toHaveLength(2);
    expect(tags(two)).toEqual([]);
    const reasons = (n: number): ClaimContext => {
      let left = n;
      return { ...two, comments: two.comments!.filter((x) => x.code !== "830100086" || left-- > 0) };
    };
    expect(tags(reasons(1))).toEqual(["comment_missing:T162-reason"]);
    expect(tags(reasons(0))).toEqual(["comment_missing:T162-reason"]);
    // 往診料と訪問診療料が別の日（K5）なら、理由の記載は求めない
    expect(K5.comments!.some((x) => x.code === "830100086")).toBe(false);
    expect(tags(K5)).toEqual([]);
  });
});

describe("週 4 回以上の訪問（完了条件 (f)）", () => {
  it("別表第七の患者の週 4 回以上では、急性増悪の記載（項番167）を求めない", () => {
    expect(K3.facts.table7).toEqual({ known: true, value: true });
    expect(K3.comments!.some((x) => REV.comments.find((r) => r.id === "T167-acute")!.codes.includes(x.code))).toBe(false);
    expect(tags(K3)).toEqual([]);
    // 急性増悪でもない（R13 が要件不足を出す）なら、記載は求めない
    expect(tags(withFact(K3, "table7", { known: true, value: false }))).toEqual([]);
  });

  it("急性増悪で週 4 回訪問し、訪問した日の記載が 1 日分だけなら、足りない 3 日が指摘に出る", () => {
    expect(ACUTE.comments!.filter((x) => x.code === "850100095").map((x) => dateOfWareki(x.text))).toEqual(ACUTE_DAYS);
    expect(tags(ACUTE)).toEqual([]);
    const oneDay: ClaimContext = { ...ACUTE, comments: ACUTE.comments!.filter((x) => x.code !== "850100095" || x.text === warekiOf(ACUTE_DAYS[0])) };
    const found = r17(oneDay);
    expect(found.map((f) => [keyOf(f), f.params?.lacking])).toEqual([["comment_mismatch_acuteVisitDates", ACUTE_DAYS.slice(1).join(",")]]);
    expect(findingText(found[0])).toMatch(/記載のない日：\d+\/6、\d+\/7、\d+\/8）$/);
    // 週 4 回の週の外の日が書いてあっても、指摘しない（含んでいればよい）
    expect(tags({ ...ACUTE, comments: [...ACUTE.comments!, commentOf("850100095", warekiOf(day(12))!, [])] })).toEqual([]);
  });

  it("別表第七に当たるか・急性増悪かが不明なら情報不足（宛先は医師）。看取りの場所が不明でも同じ", () => {
    const unknown = (key: "table7" | "acuteExacerbation") => withFact(ACUTE, key, { known: false });
    expect(tags(unknown("table7"))).toEqual(["情報不足:table7"]);
    expect(tags(unknown("acuteExacerbation"))).toEqual(["情報不足:acuteExacerbation"]);
    const place = r17(withFact(K5, "deathPlace", { known: false }));
    expect(place).toEqual([expect.objectContaining({ kind: "情報不足", lineRefs: ["C001_N6_TERMINAL"], missing: { target: "doctor", field: "deathPlace" } })]);
  });
});

describe("導出の「摘要欄に書くこと」", () => {
  const derive = (name: string) => {
    const c = loadCase(name);
    const choices = (c as ClaimContext & { choices?: Record<string, string> }).choices ?? {};
    return { c, r: deriveLines({ yearMonth: c.yearMonth, facility: c.facility, facts: c.facts, events: c.events, history: c.history, manual: manualLinesOf(c.lines, REV), choices }, REV) };
  };
  const brief = (name: string) => derive(name).r.comments.map((x) => `${x.rule} ${x.kubun} ${x.code} ${x.text} ${x.status}`);

  it("年月日は行・出来事の日付から和暦 7 桁に。包括的支援加算の状態は、要介護3 以上と分かっているときだけ。決められないものは needsInput", () => {
    const w = (n: number) => warekiOf(day(n));
    expect(brief("K1")).toEqual([`T176-date C002_2I1 850100106 ${w(14)} ready`, `T176-date C002_2I1 850100106 ${w(28)} ready`, "T216-spo2 C103_2 null null needsInput"]);
    expect(brief("K2")).toEqual([
      `T176-date C002_2RO1 850100106 ${w(14)} ready`,
      `T176-date C002_2RO1 850100106 ${w(28)} ready`,
      "T178-state C002_N10_HOKATSU 820100626  ready",
      // 算定開始月が前の月なので、初回の日は記録にない
      "T177-first C002_N4_IKOU 850100108 null needsInput",
    ]);
    expect(brief("K4")).toEqual([`T176-date C002-2_2RO1 850100107 ${w(13)} ready`, `T176-date C002-2_2RO1 850100107 ${w(27)} ready`]);
    expect(brief("K5")).toContain(`T169-death C001_N6_TERMINAL 850100098 ${w(22)} ready`);
    expect(brief("K6")).toEqual([]);
  });

  it("同梱の UKE のコメントは、導出と同じ関数で作ったもの（人が入れる記載だけ、EM 5-1 の合成の設定から）", () => {
    for (const name of ["K1", "K2", "K3", "K4", "K7"]) {
      const { c, r } = derive(name);
      const uke = commentsOfCase(c, src.commentValues?.[c.claimId]).map((x) => `${x.code} ${x.text}`);
      const ready = r.comments.filter((x) => x.status === "ready").map((x) => `${x.code} ${x.text}`);
      for (const x of ready) expect(uke, name).toContain(x);
      expect(uke.length - ready.length, name).toBe(r.comments.filter((x) => x.status === "needsInput").length);
    }
    // 合成の設定がない請求は、記載もれの UKE を黙って作らない
    expect(() => commentsOfCase(loadCase("K1"), {})).toThrow(/摘要欄の記載の値がない: T216-spo2/);
  });

  it("EM 5-1 の「摘要欄の記載の値」の表と、同梱の設定（fixtures/uke/patients.json の commentValues）が同じ", () => {
    const start = em.indexOf("**摘要欄の記載の値");
    const rows = em.slice(start, em.indexOf("\n### ", start)).split("\n").map((l) => l.split("|").slice(1, -1).map((c) => c.trim())).filter((c) => /^K\d$/.test(c[0] ?? ""));
    const value = (s: string) => {
      const m = /^令和(\d+)年(\d+)月(\d+)日$/.exec(s);
      return m ? `5${m[1].padStart(2, "0")}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}` : s;
    };
    const want = Object.fromEntries(rows.map((c) => [`${c[0]}-${YM}`, { [c[1]]: [{ code: codesIn(c[2])[0], text: value(c[3]) }] }]));
    expect(rows).toHaveLength(3);
    expect(src.commentValues).toEqual(want);
  });

  it("算定プレビュー：ready のコメントを付けて R17 を回す。needsInput が残っていれば comment_missing が出て、行の下に「摘要欄に書くこと」が並ぶ", () => {
    const preview = (name: string) => {
      const { c, r } = derive(name);
      const comments = r.comments.flatMap((x) => (x.status === "ready" ? [commentOf(x.code!, x.text!, [x.kubun])] : []));
      const engine = evaluate({ ...c, lines: r.lines, comments, commentsKnown: true });
      return { engine, view: claimPreviewOf(r, engine, REV) };
    };
    const k1 = preview("K1");
    expect(k1.engine.findings.filter((f) => f.ruleId === "R17").map((f) => `${keyOf(f)}:${f.params?.rule}`)).toEqual(["comment_missing:T216-spo2"]);
    expect(k1.view.lines.find((l) => l.kubun === "C002_2I1")!.comments).toEqual([
      { what: REV.comments.find((x) => x.id === "T176-date")!.summary, entries: [14, 28].map((n) => ({ code: "850100106", text: warekiOf(day(n)), status: "ready" })) },
    ]);
    expect(k1.view.lines.find((l) => l.kubun === "C103_2")!.comments).toEqual([{ what: REV.comments.find((x) => x.id === "T216-spo2")!.summary, entries: [{ code: null, text: null, status: "needsInput" }] }]);
    expect(k1.view.lines.find((l) => l.kubun === "C001_1I")!.comments).toEqual([]);
    expect(k1.view.findings.find((f) => f.ruleId === "R17")).toMatchObject({ kind: "記載もれ", text: expect.stringContaining("動脈血酸素分圧又は動脈血酸素飽和度") });
    // 値まで決まる記載だけの請求（K4）は、R17 の指摘なし
    expect(preview("K4").engine.findings.filter((f) => f.ruleId === "R17")).toEqual([]);
  });
});
