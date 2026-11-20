// F4：UKE 2 本（spec FR-05・FR-06）と、記録条件仕様に合わせた読み書き（design.md §11-14 の完了条件 (a)〜(e)、§11-8 の完了条件 4）。
// 点検の対象外の単位（§11-11 完了条件 (f)）と、保存済みのレセプトの読み直し（§11-12 完了条件 (f)）もここ
import iconv from "iconv-lite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BILLING_MONTH, CASES, EXTRA, generate, generateExtra, loadSources, UKE_FILES } from "../../scripts/gen-uke";
import { evaluate } from "../../src/engine";
import { hasRevision, pointsOf, resolveRevision, revisionById, UKE_TRIAL_REVISIONS } from "../../src/engine/revisions";
import { codeOf } from "../../src/engine/revisions/codes";
import type { Revision } from "../../src/engine/revisions/types";
import type { Comment } from "../../src/engine/types";
import { buildUkeFiles, commentsOfCase, payerOfInsurer, toClaimContext } from "../../src/uke/cases";
import { DISEASE_CODES } from "../../src/uke/diseases";
import { UKE_LIMITS } from "../../src/uke/limits";
import type { UkeFile } from "../../src/uke/types";
import { formatUke, mapClaim, parseUke, readStoredUke, readUke, UkeError, UNREADABLE, writeUke } from "../../src/uke/uke";
import { uploadClaimIdOf } from "../../src/uke/upload";
import { loadCase } from "../engine/helpers";
import { claimId, dateIn, day, month, YM } from "../helpers/period";

const root = path.join(__dirname, "..", "..");
const read = (f: string) => readFileSync(path.join(root, f));
const files = { 国保連: readUke(read(UKE_FILES.国保連)), 支払基金: readUke(read(UKE_FILES.支払基金)) };
const enc = (s: string) => Buffer.concat([iconv.encode(s, "Shift_JIS"), Buffer.from([0x1a])]);
const textOf = (b: Buffer) => new TextDecoder("shift_jis").decode(b.subarray(0, -1));
const rev = resolveRevision(YM);
const code = (kubun: string) => codeOf(rev, kubun);
const pts = (kubun: string) => pointsOf(rev, kubun)!;
const em = readFileSync(path.join(root, "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8");

describe("2 本を読む", () => {
  it("IR=2（国保連）で K1〜K5 と K7、IR=1（支払基金）で K6。合わせて 7 件", () => {
    expect(read(UKE_FILES.国保連).toString("latin1").startsWith("IR,2,13,1,")).toBe(true);
    expect(read(UKE_FILES.支払基金).toString("latin1").startsWith("IR,1,13,1,")).toBe(true);
    expect(files.国保連.receipts.map((r) => r.claimId)).toEqual([claimId("K1"), claimId("K2"), claimId("K3"), claimId("K4"), claimId("K5"), claimId("K7")]);
    expect(files.支払基金.receipts.map((r) => r.claimId)).toEqual([claimId("K6")]);
    expect(files.国保連.billingMonth).toBe(BILLING_MONTH);
  });

  it("読んだレセプトとカルテ側の事実を合わせると、症例 JSON と同じ行・同じ判定になる。UKE から作った請求は commentsKnown が真で、必須のコメントを持ち、摘要欄の記載（R17）の指摘は 0 件（§11-8 完了条件 4・§11-13 完了条件 (b)）", () => {
    const { src } = loadSources();
    // UKE の中の並びは行（単位）の順なので、並びは問わない
    const pairs = (cs: Comment[]) => cs.map((c) => `${c.code} ${c.text}`).sort();
    for (const k of CASES) {
      const want = loadCase(k);
      const file = want.payer === "国保連" ? files.国保連 : files.支払基金;
      const got = toClaimContext(file, want.claimId, { facility: want.facility, facts: want.facts, events: want.events, recordsKnown: want.recordsKnown, history: want.history });
      expect(got.lines).toEqual(want.lines);
      // コメントは、症例の行・事実・出来事（と EM 5-1 の合成の設定）から作ったもの。文字データは半角に寄せて読める
      expect(pairs(got.comments ?? [])).toEqual(pairs(commentsOfCase(want, src.commentValues?.[want.claimId])));
      expect([got.commentsKnown, want.commentsKnown]).toEqual([true, false]);
      expect([got.yearMonth, got.payer, got.prefecture]).toEqual([want.yearMonth, want.payer, want.prefecture]);
      // 判定は、R17 が当たる（コメントを持つ請求だけ）ことを除いて同じ。R17 の指摘は出ない
      const [a, b] = [evaluate(got), evaluate(want)];
      expect({ ...a, applied: a.applied.filter((id) => id !== "R17") }).toEqual(b);
      expect(b.applied).not.toContain("R17");
    }
  });

  it("K1〜K7 の合計は変わらない（HO の合計点数。K5・K6 は内訳の行の小計。§11-14 完了条件 (e)）", () => {
    const totals = [...parseUke(read(UKE_FILES.国保連)).claims, ...parseUke(read(UKE_FILES.支払基金)).claims].map((c) => [c.patientNo, c.total?.points]);
    expect(totals).toEqual([
      [claimId("K1"), 14806],
      [claimId("K2"), 6372],
      [claimId("K3"), 16260],
      [claimId("K4"), 4540],
      [claimId("K5"), 10175],
      [claimId("K7"), 4972],
      [claimId("K6"), 274],
    ]);
  });

  it("同じ区分を 2 行に分けた UKE でも、月 1 回の判断料の 2 回目を見逃さない（X-75）", () => {
    const { cases, src } = loadSources();
    const k2 = cases.find((c) => c.claimId === claimId("K2"))!;
    const want = loadCase("K2");
    const twice = { ...k2, lines: [...k2.lines, { kubun: "D026_3", count: 1, dates: [day(28)] }] };
    const file = readUke(writeUke(buildUkeFiles([twice], src, BILLING_MONTH).国保連));
    const got = toClaimContext(file, k2.claimId, { facility: want.facility, facts: want.facts, events: want.events, recordsKnown: want.recordsKnown, history: want.history });
    expect(got.lines.filter((l) => l.kubun === "D026_3")).toHaveLength(2);
    expect(evaluate(got).findings.map((f) => f.messageKey)).toEqual(["R11.judgement_once_a_month"]);
  });

  it("K3 は公費（54）が 1 件目の KO に載り、負担区分は 2（医保＋公費①）", () => {
    const k3 = files.国保連.receipts.find((r) => r.claimId === claimId("K3"))!;
    expect(k3.patient.kohi.map((x) => x.payerNo.slice(0, 2))).toEqual(["54"]);
    expect(k3.patient.receiptType).toBe("1328");
    const text = textOf(read(UKE_FILES.国保連));
    const k3si = text.split("\r\n").slice(text.split("\r\n").findIndex((l) => l.includes(claimId("K3")))).find((l) => l.startsWith("SI,"))!;
    expect(k3si.split(",")[2]).toBe("2");
  });

  it("K5 の主傷病の転帰は死亡（3）", () => {
    const k5 = files.国保連.receipts.find((r) => r.claimId === claimId("K5"))!;
    expect(k5.patient.diseases[0]).toMatchObject({ name: "末期悪性腫瘍", main: true, outcome: 3 });
  });
});

describe("傷病名（design.md §11-1）", () => {
  it("傷病名のコードの表は、EM §2-8 の傷病名の表で「完全一致」の行と同じ", () => {
    const rows = em
      .split("\n")
      .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
      .filter((c) => c.length === 4 && /^\d{7}$/.test(c[2]) && c[3] === "完全一致");
    expect(Object.fromEntries(rows.map((c) => [c[0], c[2]]))).toEqual(DISEASE_CODES);
    expect(rows).toHaveLength(6);
  });

  it("名称が表にある傷病名はマスターのコードで書き、名称は書かない。表にない傷病名は未コード化（0000999）と名称で書く。読み戻すと元の名称になる", () => {
    const sy = textOf(read(UKE_FILES.国保連)).split("\r\n").filter((l) => l.startsWith("SY,")).map((l) => l.split(","));
    expect(sy.filter((c) => c[1] !== "0000999").every((c) => Object.values(DISEASE_CODES).includes(c[1]) && c[5] === "")).toBe(true);
    expect(sy.filter((c) => c[1] === "0000999").map((c) => c[5])).toEqual(["末期悪性腫瘍"]);
    const { src } = loadSources();
    for (const r of [...files.国保連.receipts, ...files.支払基金.receipts]) expect(r.patient, r.claimId).toEqual(src.patients[r.claimId]);
  });

  it("表にない傷病名コードも受け取り、コードを保持する（名称は持たない）。形の違うコードは断る", () => {
    const text = textOf(read(UKE_FILES.支払基金));
    const file = readUke(enc(text.replace(/^SY,0000999,(\d+),1,,[^,]*,/m, "SY,8830001,$1,1,,,")));
    expect(file.receipts[0].patient.diseases).toEqual([{ name: "", code: "8830001", start: expect.stringMatching(/^\d{8}$/), main: true }]);
    // 保持したコードは、書き出しでもそのまま書く
    expect(formatUke(file)).toMatch(/\r\nSY,8830001,\d{8},1,,,01,\r\n/);
    expect(() => readUke(enc(text.replace(/^SY,0000999,/m, "SY,883000,")))).toThrow("7 行目：傷病名コードの形が違う");
  });

  it("修飾語コード（4 桁ずつ）・主傷病・転帰・補足コメントを読んで保持し、書き出しても同じ（手引き p24 の記録例の形。値は合成）", () => {
    const text = textOf(read(UKE_FILES.支払基金));
    const sy = "SY,8830001,20260707,1,20568002,,,\r\nSY,8830002,20260710,4,,,01,\r\nSY,8830003,20260712,1,,,,健診にて\r\nSY,0000999,20260714,2,,架空の病名,,\r\n";
    const file = readUke(enc(text.replace(/^SY,.*\r\n/m, sy)));
    expect(file.receipts[0].patient.diseases).toEqual([
      { name: "", code: "8830001", start: "20260707", modifiers: ["2056", "8002"] },
      { name: "", code: "8830002", start: "20260710", main: true, outcome: 4 },
      { name: "", code: "8830003", start: "20260712", note: "健診にて" },
      { name: "架空の病名", start: "20260714", outcome: 2 },
    ]);
    expect(formatUke(file)).toContain(`\r\n${sy}`);
    expect(() => readUke(enc(text.replace(/^(SY,\d+,\d+,1,),/m, "$1205,")))).toThrow("7 行目：修飾語コードの形が違う");
  });
});

describe("形式（FR-06）", () => {
  it("Shift_JIS・CRLF・末尾 EOF(0x1A)。レコード順は IR→(RE→HO/KO→SN→JD→MF→SY→SI/CO)×n→GO", () => {
    for (const f of Object.values(UKE_FILES)) {
      const b = read(f);
      expect(b[b.length - 1]).toBe(0x1a);
      const text = new TextDecoder("shift_jis", { fatal: true }).decode(b.subarray(0, -1));
      expect(text.endsWith("\r\n")).toBe(true);
      expect(text.replaceAll("\r\n", "").includes("\n")).toBe(false);
      const kinds = text.slice(0, -2).split("\r\n").map((l) => l.slice(0, 2));
      expect(kinds.join(" ")).toMatch(/^IR( RE HO( KO)*( SN)+( JD)+ MF( SY)+( SI( CO)*)+)+ GO$/);
    }
  });

  it("列数は IR 10・RE 38・HO 15・KO 12・SN 9・JD 33・MF 33・SY 8・SI 44・GO 4", () => {
    const want: Record<string, number> = { IR: 10, RE: 38, HO: 15, KO: 12, SN: 9, JD: 33, MF: 33, SY: 8, SI: 44, CO: 5, GO: 4 };
    for (const f of Object.values(UKE_FILES)) {
      for (const l of textOf(read(f)).slice(0, -2).split("\r\n")) expect(l.split(",").length).toBe(want[l.slice(0, 2)]);
    }
  });

  it("見本の資格確認（SN）・受診日等（JD）・窓口負担額（MF）：SN は保険者レコードごとに 1 つ（枝番は後期高齢者医療では書かない。54 の公費には書かない）、JD は負担者ごとに算定のある日、MF は区分だけ。読むと、HO の診療実日数と JD の日数が合う", () => {
    for (const f of Object.values(UKE_FILES)) {
      for (const c of parseUke(read(f)).claims) {
        expect(c.eligibility).toEqual([{ payerKind: "1", confirmation: "01" }]);
        expect(c.visits.map((v) => v.payerKind)).toEqual(["1", ...c.patient.kohi.map((_, i) => String(i + 2))]);
        const visited = c.units.reduce<number[]>((days, u) => days.map((n, i) => (u.days[i] > 0 ? 1 : n)), Array(31).fill(0));
        for (const v of c.visits) expect(v.days).toEqual(visited);
        expect(c.realDays).toBe(visited.filter((n) => n === 1).length);
        expect(c.copay).toEqual(["00"]);
        expect([c.dpcExclusions, c.notes]).toEqual([[], []]);
      }
    }
    const sn = (f: string) => textOf(read(f)).split("\r\n").filter((l) => l.startsWith("SN,"));
    expect(new Set(sn(UKE_FILES.国保連))).toEqual(new Set(["SN,1,01,,,,,,"]));
    expect(sn(UKE_FILES.支払基金)).toEqual(["SN,1,01,,,,01,,"]);
  });

  it("書き出しは入力だけで決まる（作り直したものとファイルが一致）", () => {
    const out = generate();
    expect(out.国保連.equals(read(UKE_FILES.国保連))).toBe(true);
    expect(out.支払基金.equals(read(UKE_FILES.支払基金))).toBe(true);
  });

  it("SI のコードは、診療年月の版の表どおり（区分の primary。包括の検査の区分は、症例ごとの検査項目のコード）", () => {
    const { cases, src } = loadSources();
    const codes = new Set(textOf(read(UKE_FILES.国保連)).split("\r\n").filter((l) => l.startsWith("SI,")).map((l) => l.split(",")[3]));
    const want = new Set(cases.filter((c) => c.payer === "国保連").flatMap((c) => c.lines.flatMap((l) => src.bundleItems?.[c.claimId]?.[l.kubun] ?? [code(l.kubun)])));
    expect([...codes].sort()).toEqual([...want].sort());
    // 99 で始まる作り物のコードは残っていない
    expect([...codes].filter((c) => c.startsWith("99"))).toEqual([]);
  });

  it("包括の検査の項目は、EM 5-1 の表の行と同じ（症例ごとの合成の設定）。区分 D007_10 は 10 項目を 1 行ずつ並べ、点数は最後の行だけ", () => {
    const { src } = loadSources();
    const start = em.indexOf("**包括の検査の項目");
    const rows = em.slice(start, em.indexOf("\n**", start + 2)).split("\n").map((l) => l.split("|").slice(1, -1).map((c) => c.trim())).filter((c) => /^K\d$/.test(c[0] ?? ""));
    const k1 = rows.find((c) => c[0] === "K1")![3].match(/\d{9}/g)!;
    expect(k1).toHaveLength(10);
    // K2・K7 は「K1 と同じ 10 項目」
    expect(rows.map((c) => [c[0], c[1], c[3].startsWith("K1 と同じ") || c[0] === "K1"])).toEqual([["K1", "D007_10", true], ["K2", "D007_10", true], ["K7", "D007_10", true]]);
    expect(src.bundleItems).toEqual(Object.fromEntries(rows.map((c) => [claimId(c[0]), { D007_10: k1 }])));
    expect(k1.every((c) => rev.bundles[0].members.includes(c))).toBe(true);
    const k1si = textOf(read(UKE_FILES.国保連)).split("\r\n").filter((l) => l.startsWith("SI,")).map((l) => l.split(","));
    const at = k1si.findIndex((c) => c[3] === k1[0]);
    expect(k1si.slice(at, at + 10).map((c) => [c[1], c[3], c[5]])).toEqual(k1.map((c, i) => [i === 0 ? "60" : "", c, i === 9 ? String(pts("D007_10")) : ""]));
  });

  it("診療識別は、版の表の値を単位の先頭の行に書く", () => {
    const rows = textOf(read(UKE_FILES.国保連)).split("\r\n").filter((l) => l.startsWith("SI,")).map((l) => l.split(","));
    const of = (kubun: string) => rows.find((c) => c[3] === code(kubun))![1];
    expect([of("C001_1I"), of("C002_2I1"), of("D005_5"), of("O001_3I"), of("C000")]).toEqual(["14", "14", "60", "80", "14"]);
  });

  it("壊れた UKE は例外：EOF なし・GO の合計違い・算定日と回数の不一致・RE より前の SI", () => {
    const good = read(UKE_FILES.支払基金);
    expect(() => readUke(good.subarray(0, -1))).toThrow(/EOF/);
    const text = textOf(good);
    expect(() => readUke(enc(text.replace(/GO,1,(\d+),99/, "GO,1,1,99")))).toThrow(/総合計点数/);
    expect(() => readUke(enc(text.replace(/^(SI,60,1,\d+,,130,)1,/m, "$12,")))).toThrow(/回数/);
    expect(() => readUke(enc(text.replace(/^RE,.*\r\nHO,.*\r\n/m, "")))).toThrow(/RE より前/);
  });

  describe("受け取れない入力は、行番号つきの UkeError になる（FR-106・FR-107）", () => {
    const good = read(UKE_FILES.支払基金);
    const text = textOf(good);
    /** 壊した UKE を読ませて、行番号と理由を取り出す（UkeError でなければテストを落とす） */
    const reject = (buf: Buffer): [number | null, string] => {
      try {
        readUke(buf);
      } catch (e) {
        if (e instanceof UkeError) return [e.line, e.reason];
        throw e;
      }
      throw new Error("読めてしまった");
    };
    /** n 行目（1 起算）の col 列目（0 起算）を差し替える */
    const withCell = (n: number, col: number, value: string) => {
      const rows = text.slice(0, -2).split("\r\n").map((l) => l.split(","));
      rows[n - 1][col] = value;
      return enc(`${rows.map((r) => r.join(",")).join("\r\n")}\r\n`);
    };
    /** K6 の見本の行：1 IR・2 RE・3 HO・4 SN・5 JD・6 MF・7 SY・8 SI・9 SI・10 GO。SI の 14 列目（0 起算で 13）からが 1 日〜31 日の回数 */
    const SI = 8;

    it("列数の不足・未対応のレコード・項目の長すぎ・制御文字", () => {
      expect(reject(enc(text.replace(/^(SI,.*),\r\n/m, "$1\r\n")))).toEqual([SI, "列数が合わない"]);
      // 識別情報の形（英大文字 2 字）でないレコードは、ファイルごと断る。形が合っていて知らないレコードは、そのレセプトだけが読めなくなる（下の「レコードの種類」）
      expect(reject(enc(text.replace(/^SY,/m, "Xx,")))).toEqual([7, "未対応のレコード"]);
      expect(reject(enc(text.replace(/^constructor,/m, "").replace(/^SY,/m, "constructor,")))).toEqual([7, "未対応のレコード"]);
      expect(reject(withCell(2, 4, "あ".repeat(UKE_LIMITS.maxFieldLength + 1)))).toEqual([2, "項目が長すぎる"]);
      expect(reject(withCell(2, 4, "架空\u0000六郎"))).toEqual([2, "制御文字がある"]);
    });

    it("範囲の外の数値・数字でない項目（符号・小数・指数を含む）・形の違うコード", () => {
      expect(reject(withCell(2, 5, "3"))).toEqual([2, "性別が範囲の外"]);
      expect(reject(withCell(2, 3, "202613"))).toEqual([2, "診療年月の形が違う"]);
      expect(reject(withCell(2, 6, "1956-04-01"))).toEqual([2, "生年月日の形が違う"]);
      expect(reject(withCell(SI, 6, "0"))).toEqual([SI, "回数が範囲の外"]);
      for (const v of ["-1", "1.5", "1e9", "Infinity", "", " 1"]) expect(reject(withCell(SI, 6, v))).toEqual([SI, "回数が数字でない"]);
      expect(reject(withCell(SI, 5, "99999999"))).toEqual([SI, "点数が範囲の外"]);
      for (const v of ["16016235", "1601623500", "16016235a", ""]) expect(reject(withCell(SI, 3, v))).toEqual([SI, "コードの形が違う"]);
      expect(reject(withCell(SI, 1, "6"))).toEqual([SI, "診療識別の形が違う"]);
      expect(reject(withCell(SI, 4, "abc"))).toEqual([SI, "数量データの形が違う"]);
      expect(reject(withCell(SI, 7, "82010000"))).toEqual([SI, "コメントコードの形が違う"]);
      expect(reject(withCell(SI, 8, "コードのない文字データ"))).toEqual([SI, "コメントコードの形が違う"]);
    });

    it("単位の点数が版の点数表と合わない・HO の合計点数が行の合計と合わないものは断る。理由に値は入らない（X-76）", () => {
      // BNP の点数 130 → 9999。HO の合計 274 → 1
      expect(reject(withCell(SI, 5, "9999"))).toEqual([SI, "点数が診療年月の版の点数表と合わない"]);
      expect(reject(withCell(3, 5, "1"))).toEqual([3, "合計点数が行の合計と合わない"]);
      // BNP の点数を空にすると、次の行（判断料 144）までが 1 つの単位になり、2 つの区分の合計（274）と合わない
      expect(reject(withCell(SI, 5, ""))).toEqual([SI + 1, "点数が診療年月の版の点数表と合わない"]);
      // 最後の行の点数が空だと、単位が終わらない
      expect(reject(withCell(SI + 1, 5, ""))).toEqual([SI + 1, "点数のない行で単位が終わっている"]);
      for (const buf of [withCell(SI, 5, "9999"), withCell(3, 5, "12345")]) expect(() => readUke(buf)).toThrow(/^\d+ 行目：(?!.*(9999|12345|130|274))/);
      // 同梱の見本は 2 本とも通る
      for (const f of Object.values(UKE_FILES)) expect(() => readUke(read(f))).not.toThrow();
    });

    it("1 日の回数は上限まで。大きな数を入れても、日付の並びを作らずに断る", () => {
      const day1 = 13;
      const started = Date.now();
      // 1 日の回数は 3 桁まで（記録条件仕様 p17）
      for (const v of ["1000", "999999999", "1e9", "-1", "1.5"]) expect(reject(withCell(SI, day1, v))).toEqual([SI, "1 日の回数が上限を超えている"]);
      for (const v of ["1000", "9999"]) expect(reject(withCell(SI, 6, v))).toEqual([SI, "回数が範囲の外"]);
      expect(Date.now() - started).toBeLessThan(1000);
      // 上限の中でも、回数と合わなければ断る
      expect(reject(withCell(SI, day1, String(UKE_LIMITS.maxDailyCount)))).toEqual([SI, "算定日の合計と回数が合わない"]);
    });

    it("「カルテ番号等」の欄は患者の番号として読むだけで、請求 id として確かめない（文字種も重複も見ない）。請求 id は読む側が渡す。診療年月に当たる版がないものは断らず、区分に引かないまま残す（design.md §11-12）", () => {
      // 空・記号・全角・同じ番号の 2 枚目も読める。請求 id は渡した決め方（ここでは取り込みの連番 7）で決まり、欄の値は patientNo に残る
      for (const v of ["../K6", "K6/x", "K6 2026", "", "K6.json", "Ｋ６", "x".repeat(21)]) {
        // 「カルテ番号等」は RE の項目 14（0 起算で 13。記録条件仕様 p6、手引き p8 の記録例）
        const r = readUke(withCell(2, 13, v), uploadClaimIdOf(7)).receipts[0];
        expect([r.claimId, r.patientNo]).toEqual(["U7-1", v]);
      }
      const twice = text.replace(/^(RE,[\s\S]*)(GO,1,)(\d+)(,99\r\n)$/m, (_, body: string, go: string, total: string, tail: string) => `${body}${body}GO,2,${Number(total) * 2}${tail}`);
      expect(readUke(enc(twice), uploadClaimIdOf(7)).receipts.map((r) => [r.claimId, r.patientNo])).toEqual([["U7-1", claimId("K6")], ["U7-2", claimId("K6")]]);
      // 決め方を渡さなければ、欄の値がそのまま請求 id（同梱の見本は、この欄に症例の請求 id を書いてある）
      expect(readUke(good).receipts.map((r) => r.claimId)).toEqual([claimId("K6")]);
      // 版がないことは、形式の読み取り（parseUke）でも取り込み（readUke）でも断らない。コードを区分に引かず、UKE に書いてある合計だけを持つ
      const old = withCell(2, 3, "202503");
      expect(parseUke(old).claims[0].yearMonth).toBe("2025-03");
      const r = readUke(old).receipts[0];
      expect([r.noRevision, r.yearMonth, r.lines, r.comments, r.declared, r.unreadable]).toEqual([true, "2025-03", [], [], { ho: 274, ko: [] }, undefined]);
      expect(readStoredUke(old).receipts[0]).toEqual(r);
      // 版のあるレセプトは、印を持たない
      expect(readUke(good).receipts[0].noRevision).toBeUndefined();
      // 合計の検査は版によらないので、版のないレセプトでも断る（3 行目は HO）
      const rows = textOf(old).slice(0, -2).split("\r\n").map((l) => l.split(","));
      rows[2][5] = "275";
      expect(reject(enc(`${rows.map((c) => c.join(",")).join("\r\n")}\r\n`))).toEqual([3, "合計点数が行の合計と合わない"]);
    });

    it("大きすぎるファイル・多すぎる行・Shift_JIS でないバイト列・空のファイル", () => {
      expect(reject(Buffer.alloc(UKE_LIMITS.maxBytes + 1, 0x41))).toEqual([null, "ファイルが大きすぎる"]);
      const many = `${"SY,0000999,20260801,1,,x,,\r\n".repeat(UKE_LIMITS.maxLines + 1)}`;
      expect(reject(enc(many))).toEqual([null, "レコードの数が上限を超えている"]);
      expect(reject(Buffer.from([0x81, 0x0d, 0x0a, 0x1a]))).toEqual([null, "Shift_JIS として読めない"]);
      expect(reject(Buffer.alloc(0))).toEqual([null, "末尾に EOF(0x1A) がない"]);
      expect(reject(enc("IR,1,13,1,9999999,,x,202611,00,0300000000\r\n"))).toEqual([1, "末尾が GO レコードでない"]);
    });

    it("理由に、入力の値（氏名・番号・コード）は入らない", () => {
      const cases = [withCell(SI, 3, "10000000x"), withCell(2, 6, "secret"), withCell(2, 5, "架空の値"), withCell(1, 2, "99"), enc(text.replace(/^SY,/m, "ZZ99,"))];
      for (const buf of cases) {
        const message = (() => {
          try {
            readUke(buf);
            return "";
          } catch (e) {
            return (e as Error).message;
          }
        })();
        expect(message).toMatch(/^\d+ 行目：/);
        expect(message).not.toMatch(/10000000x|secret|架空の値|ZZ99|六郎|01139997/);
      }
    });
  });

  it("書けない入力は例外：その版にコードのない区分、診療年月の外の日付、項目のない包括の検査、基本の項目のない注加算", () => {
    const { cases, src } = loadSources();
    const k6 = cases.find((c) => c.claimId === claimId("K6"))!;
    const write = (lines: typeof k6.lines) => formatUke(buildUkeFiles([{ ...k6, lines }], src, BILLING_MONTH).支払基金);
    // 前の年度だけの区分（診療年月の版の表にない）
    expect(() => write([...k6.lines, { kubun: "O100_3I", count: 1, dates: [day(14)] }])).toThrow(/コードのない区分/);
    expect(() => write([{ kubun: "D008_19", count: 1, dates: [dateIn(1, 1)] }])).toThrow(/診療年月の外/);
    expect(() => write([{ kubun: "D007_10", count: 1, dates: [day(14)] }])).toThrow(/包括の検査の項目/);
    expect(() => write([{ kubun: "C000_N1_KINKYU", count: 1, dates: [day(14)] }])).toThrow(/注加算/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 記録条件仕様に合わせた読み書き（design.md §11-14）。値は合成（コードは版の表のもの、コメントコード・医薬品・特定器材のコードは作り物の番号）

/** n 列のレコード（1 起算の列番号 → 値） */
const rec = (n: number, cols: Record<number, string | number>) => {
  const out: string[] = Array.from({ length: n }, () => "");
  for (const [k, v] of Object.entries(cols)) out[Number(k) - 1] = String(v);
  return out.join(",");
};
type SiOpt = { points?: number; count?: number; on?: number; quantity?: number; comments?: [string, string][] };
/** SI の 1 行。点数を省くと空（単位の途中の行）。算定日は on 日に count 回 */
const si = (shikibetsu: string, c: string, o: SiOpt = {}) =>
  rec(44, {
    1: "SI",
    2: shikibetsu,
    3: 1,
    4: c,
    5: o.quantity ?? "",
    6: o.points ?? "",
    7: o.count ?? 1,
    ...Object.fromEntries((o.comments ?? []).flatMap(([cc, t], i) => [[8 + i * 2, cc], [9 + i * 2, t]])),
    [14 + (o.on ?? 5) - 1]: o.count ?? 1,
  });
const co = (shikibetsu: string, c: string, text = "") => rec(5, { 1: "CO", 2: shikibetsu, 3: 1, 4: c, 5: text });
/** 見本（K6）の IR・RE・HO・SY を借りて、摘要の行（5 行目から）と合計を差し替えた UKE */
function ukeOf(rows: string[], total: number): Buffer {
  const head = textOf(read(UKE_FILES.支払基金)).split("\r\n").filter((l) => !/^(SN|JD|MF),/.test(l)).slice(0, 4);
  head[2] = head[2].replace(/^(HO,[^,]*,[^,]*,[^,]*,\d+,)\d+/, `$1${total}`);
  return enc(`${[...head, ...rows, `GO,1,${total},99`].join("\r\n")}\r\n`);
}
const FIRST = 5;
const members = rev.bundles[0].members;
const comment = (c: string, raw: string, on: string[] = [], text = raw): Comment => ({ code: c, text, raw, on });

/** 手引きの記録例の形を、合成の値で並べた摘要（完了条件 (a)） */
const EXAMPLE = {
  rows: [
    co("01", "820000001"), // 5：レセプト全体へのコメント
    co("", "830000001", "全体の続き"), // 6：CO,01 に続く、診療識別が空の CO
    co("14", "810000001", "単位の先頭"), // 7：先頭が CO の単位。診療識別は CO に書かれ、続く SI は空
    si("", code("C000")), // 8：途中の行は点数が空
    si("", code("C000_N1_KINKYU"), { points: pts("C000") + pts("C000_N1_KINKYU") }), // 9：注加算は合算の点数を最後の行に
    si("", code("C001_N7_MITORI"), { points: pts("C001_N7_MITORI") }), // 10：同じ診療識別の下の、2 つ目の単位
    co("", "830000002", "単位の後ろ"), // 11
    si("60", members[0]), // 12：包括の検査。項目を 1 行ずつ
    si("", members[1]), // 13
    co("", "810000002", "単位の途中"), // 14：単位の途中（点数の行より前）の CO
    si("", members[2]), // 15
    si("", members[3]), // 16
    si("", members[4], { points: pts("D007_5") }), // 17：5 項目の点数を最後の行に
    si("60", code("D_GAIRAI_JINSOKU"), { quantity: 5, points: pts("D_GAIRAI_JINSOKU") * 5 }), // 18：きざみ。数量データが項目数
    si("14", code("C103_2"), { points: pts("C103_2"), comments: [["842100072", "９５．５"]] }), // 19：SI のコメント欄
    co("60", "810000003", "独立のコメント"), // 20：診療識別つきの独立の CO
  ],
  total: pts("C000") + pts("C000_N1_KINKYU") + pts("C001_N7_MITORI") + pts("D007_5") + pts("D_GAIRAI_JINSOKU") * 5 + pts("C103_2"),
};

describe("単位で読む（§11-14 完了条件 (a)・(b)・(d)）", () => {
  const d = [day(5)];

  it("(a) 手引きの記録例の形（途中の行の点数が空、1 つの診療識別の下に 2 つの単位、注加算の合算、包括の検査、SI のコメント欄、単位の前後の CO、全体コメント、先頭が CO の単位）を読める", () => {
    const r = readUke(ukeOf(EXAMPLE.rows, EXAMPLE.total)).receipts[0];
    expect(r.lines).toEqual([
      { kubun: "C000", count: 1, dates: d },
      { kubun: "C000_N1_KINKYU", count: 1, dates: d },
      { kubun: "C001_N7_MITORI", count: 1, dates: d },
      { kubun: "D007_5", count: 1, dates: d, items: members.slice(0, 5) },
      // きざみで算定する区分は、項目数（数量データ）を回数にし、同じ日を項目数だけ重ねる
      { kubun: "D_GAIRAI_JINSOKU", count: 5, dates: [...d, ...d, ...d, ...d, ...d] },
      { kubun: "C103_2", count: 1, dates: d },
    ]);
    // コメントは文字データを捨てない。on を埋めるのは、帰属が形式から決まるもの（SI のコメント欄と、単位の途中の CO）だけ
    expect(r.comments).toEqual([
      comment("820000001", ""),
      comment("830000001", "全体の続き"),
      comment("810000001", "単位の先頭"),
      comment("830000002", "単位の後ろ"),
      comment("810000002", "単位の途中", ["D007_5"]),
      // 全角の数字・記号は半角に寄せ、原文も残す
      comment("842100072", "９５．５", ["C103_2"], "95.5"),
      comment("810000003", "独立のコメント"),
    ]);
    expect(r.commentsKnown).toBe(true);
  });

  it("(a) 単位の最後の行は IY・TO のこともある。TO はコメント欄が項目 12〜17、算定日情報が 18〜48。医薬品・特定器材の単位は、取り込みでは断らず、点検の対象外の単位として残す", () => {
    const iy = rec(44, { 1: "IY", 2: "21", 3: 1, 4: "600000001", 5: "1.5", 6: 12, 7: 1, 8: "810000004", 9: "薬のコメント", [14 + 4]: 1 });
    const to = rec(48, { 1: "TO", 2: "14", 3: 1, 4: "700000001", 5: "2", 6: 30, 7: 2, 12: "810000005", 13: "器材のコメント", [18 + 4]: 1, [18 + 11]: 1 });
    const buf = ukeOf([si("60", code("D005_5"), { points: pts("D005_5") }), iy, to], pts("D005_5") + 12 + 60);
    const c = parseUke(buf).claims[0];
    expect(c.units.map((u) => [u.items.map((x) => [x.kind, x.code, x.quantity]), u.points, u.count, u.days.flatMap((n, i) => (n ? [i + 1] : []))])).toEqual([
      [[["SI", code("D005_5"), ""]], pts("D005_5"), 1, [5]],
      [[["IY", "600000001", "1.5"]], 12, 1, [5]],
      [[["TO", "700000001", "2"]], 30, 2, [5, 12]],
    ]);
    expect(c.comments).toEqual([
      { line: FIRST + 1, code: "810000004", raw: "薬のコメント", unit: 1 },
      { line: FIRST + 2, code: "810000005", raw: "器材のコメント", unit: 2 },
    ]);
    expect(mapClaim(c, rev).units.map((u) => (u.ok === false ? [u.line, u.reason, u.unsupported] : "ok"))).toEqual([
      "ok",
      [FIRST + 1, "医薬品・特定器材の行は、点検の対象にしていない", true],
      [FIRST + 2, "医薬品・特定器材の行は、点検の対象にしていない", true],
    ]);
    const r = readUke(buf).receipts[0];
    expect(r.lines.map((l) => l.kubun)).toEqual(["D005_5"]);
    expect(r.others).toEqual([
      { unit: 1, codes: ["600000001"], points: 12, count: 1, days: c.units[1].days },
      { unit: 2, codes: ["700000001"], points: 30, count: 2, days: c.units[2].days },
    ]);
  });

  it("(b) 890 点の行が回数 2 のとき、点数 890・回数 2 で読む（1,780 と突き合わせない）。点数の欄に 2 回分を書いた UKE は断る", () => {
    const k1 = parseUke(read(UKE_FILES.国保連)).claims[0];
    const visit = k1.units.find((u) => u.items[0].code === code("C001_1I"))!;
    expect([visit.points, visit.count]).toEqual([890, 2]);
    expect(files.国保連.receipts[0].lines[0]).toEqual({ kubun: "C001_1I", count: 2, dates: loadCase("K1").lines[0].dates });
    const twice = rec(44, { 1: "SI", 2: "14", 3: 1, 4: code("C001_1I"), 6: 1780, 7: 2, [14 + 4]: 1, [14 + 18]: 1 });
    expect(() => readUke(ukeOf([twice], 3560))).toThrow(`${FIRST} 行目：点数が診療年月の版の点数表と合わない`);
    // 回数 2 の単位の合計は 点数 × 回数
    const ok = rec(44, { 1: "SI", 2: "14", 3: 1, 4: code("C001_1I"), 6: 890, 7: 2, [14 + 4]: 1, [14 + 18]: 1 });
    expect(readUke(ukeOf([ok], 1780)).receipts[0].lines).toEqual([{ kubun: "C001_1I", count: 2, dates: [day(5), day(19)] }]);
  });

  it("同じ単位の行は回数と算定日が同じ。そろっていない UKE・点数の行で終わらない UKE は断る", () => {
    const base = [si("14", code("C000")), si("", code("C000_N1_KINKYU"), { points: pts("C000") + pts("C000_N1_KINKYU") })];
    expect(() => readUke(ukeOf(base, pts("C000") + pts("C000_N1_KINKYU")))).not.toThrow();
    const otherDay = [base[0], si("", code("C000_N1_KINKYU"), { points: pts("C000") + pts("C000_N1_KINKYU"), on: 6 })];
    expect(() => readUke(ukeOf(otherDay, 0))).toThrow(`${FIRST + 1} 行目：同じ単位の行で、回数・算定日がそろっていない`);
    expect(() => readUke(ukeOf([base[0], co("", "810000001", "途中")], 0))).toThrow(`${FIRST} 行目：点数のない行で単位が終わっている`);
  });

  it("注加算の合算が版の点数表と合わない・包括の検査の項目数と点数が合わない単位は断る。包括にならない項目数（4 項目以下）・包括の対象でない項目が混ざる単位は、断らずに点検の対象外にする", () => {
    const sum = pts("C000") + pts("C000_N1_KINKYU");
    expect(() => readUke(ukeOf([si("14", code("C000")), si("", code("C000_N1_KINKYU"), { points: sum + 1 })], sum + 1))).toThrow(`${FIRST + 1} 行目：点数が診療年月の版の点数表と合わない`);
    const bundle = (n: number, points: number, extra: string[] = []) => {
      const codes = [...members.slice(0, n), ...extra];
      return ukeOf(codes.map((c, i) => si(i === 0 ? "60" : "", c, i === codes.length - 1 ? { points } : {})), points);
    };
    expect(readUke(bundle(5, pts("D007_5"))).receipts[0].lines[0].kubun).toBe("D007_5");
    expect(readUke(bundle(7, pts("D007_5"))).receipts[0].lines[0].kubun).toBe("D007_5");
    expect(readUke(bundle(8, pts("D007_8"))).receipts[0].lines[0].kubun).toBe("D007_8");
    expect(readUke(bundle(9, pts("D007_8"))).receipts[0].lines[0].kubun).toBe("D007_8");
    expect(readUke(bundle(10, pts("D007_10"))).receipts[0].lines[0].kubun).toBe("D007_10");
    expect(readUke(bundle(12, pts("D007_10"))).receipts[0].lines[0].kubun).toBe("D007_10");
    // 8 項目なのに 10 項目以上の点数
    expect(() => readUke(bundle(8, pts("D007_10")))).toThrow(`${FIRST + 7} 行目：点数が診療年月の版の点数表と合わない`);
    const outside = (buf: Buffer) => {
      const r = readUke(buf).receipts[0];
      return [r.lines, r.others?.map((o) => [o.unit, o.codes.length, o.points])];
    };
    expect(outside(bundle(4, pts("D007_5")))).toEqual([[], [[0, 4, pts("D007_5")]]]);
    expect(outside(bundle(5, pts("D007_5"), [code("D005_5")]))).toEqual([[], [[0, 6, pts("D007_5")]]]);
    expect(() => readUke(bundle(5, pts("D007_5"), [members[0]]))).toThrow(`${FIRST + 5} 行目：包括の検査の同じ項目が、同じ単位に 2 つある`);
  });

  it("数量データは、きざみで算定する区分（外来迅速検体検査加算）の項目数。ない・きざみでない区分にある UKE は断る", () => {
    const rapid = code("D_GAIRAI_JINSOKU");
    expect(() => readUke(ukeOf([si("60", rapid, { points: pts("D_GAIRAI_JINSOKU") })], pts("D_GAIRAI_JINSOKU")))).toThrow(`${FIRST} 行目：数量データが項目数として読めない`);
    expect(() => readUke(ukeOf([si("60", rapid, { quantity: 3, points: pts("D_GAIRAI_JINSOKU") })], pts("D_GAIRAI_JINSOKU")))).toThrow(`${FIRST} 行目：点数が診療年月の版の点数表と合わない`);
    expect(() => readUke(ukeOf([si("60", code("D005_5"), { quantity: 2, points: pts("D005_5") })], pts("D005_5")))).toThrow(`${FIRST} 行目：数量データに対応していない項目`);
  });

  it("(d) 引けないコードを含む単位だけが点検の対象外になり、同じ診療識別の下のほかの単位は点検される（mapClaim は例外にせず、単位ごとに結果か理由を返す）。取り込みでも断らず、対象外の単位として残す", () => {
    // 2 つ目の単位（看取り加算）のコードを、表にない作り物の番号にする。その単位のコメント欄にコメントを付けておく
    const rows = EXAMPLE.rows.map((l, i) => (i === 5 ? si("", "100000001", { points: pts("C001_N7_MITORI"), comments: [["810000009", "引けない単位のコメント"]] }) : l));
    const buf = ukeOf(rows, EXAMPLE.total);
    const claim = parseUke(buf).claims[0];
    const mapped = mapClaim(claim, rev);
    expect(mapped.units.map((u) => (u.ok === false ? [u.line, u.reason] : u.lines.map((l) => l.kubun)))).toEqual([
      ["C000", "C000_N1_KINKYU"],
      [FIRST + 5, "診療年月の版の表にないコード"],
      ["D007_5"],
      ["D_GAIRAI_JINSOKU"],
      ["C103_2"],
    ]);
    expect(mapped.lines.map((l) => l.kubun)).toEqual(["C000", "C000_N1_KINKYU", "D007_5", "D_GAIRAI_JINSOKU", "C103_2"]);
    // 引けない単位のコメントは、文字データは残り、on は空
    expect(mapped.comments.find((c) => c.code === "810000009")).toEqual(comment("810000009", "引けない単位のコメント"));
    expect(mapped.comments.find((c) => c.code === "842100072")!.on).toEqual(["C103_2"]);
    expect(mapped.others).toEqual([{ unit: 1, codes: ["100000001"], points: pts("C001_N7_MITORI"), count: 1, days: claim.units[1].days }]);
    const r = readUke(buf).receipts[0];
    expect(r.lines.map((l) => l.kubun)).toEqual(["C000", "C000_N1_KINKYU", "D007_5", "D_GAIRAI_JINSOKU", "C103_2"]);
    expect(r.others).toEqual(mapped.others);
    // UKE に書いてある合計（HO）は、対象外の単位も含めた行の合計と突き合わせる。合わなければ今までどおり断る
    expect(r.declared).toEqual({ ho: EXAMPLE.total, ko: [] });
    expect(() => readUke(ukeOf(rows, EXAMPLE.total - pts("C001_N7_MITORI")))).toThrow(/合計点数が行の合計と合わない/);
    // 対応しているコードの単位の点数の食い違いは、対象外の単位があっても断る
    const off = rows.map((l, i) => (i === 4 ? si("", code("C000_N1_KINKYU"), { points: pts("C000") + pts("C000_N1_KINKYU") + 1 }) : l));
    expect(() => readUke(ukeOf(off, EXAMPLE.total + 1))).toThrow(/点数が診療年月の版の点数表と合わない/);
  });

  it("コードは、渡された版の表で引く（版を決めてから）。同じ UKE でも、表の違う版では別の区分になる・引けない", () => {
    const claim = parseUke(read(UKE_FILES.支払基金)).claims[0];
    expect(mapClaim(claim, rev).lines.map((l) => l.kubun)).toEqual(["D008_19", "D026_5"]);
    const renamed: Revision = { ...rev, id: "other", points: { ...rev.points, D008_18: rev.points.D008_19 }, codes: { ...rev.codes, D008_19: { primary: "100000002", accept: [] }, D008_18: rev.codes.D008_19 } };
    expect(mapClaim(claim, renamed).lines.map((l) => l.kubun)).toEqual(["D008_18", "D026_5"]);
    const empty = mapClaim(claim, { ...rev, id: "empty", codes: {}, bundles: [] });
    expect(empty.units.map((u) => u.ok)).toEqual([false, false]);
    expect(empty.lines).toEqual([]);
  });

  it("在宅ターミナルケア加算は、イ・ロどちらのコードも同じ区分として読む。処方箋料は、リフィル処方箋・向精神薬長期処方のコードも同じ区分として読む", () => {
    const one = (c: string, kubun: string) => readUke(ukeOf([si("14", c, { points: pts(kubun) })], pts(kubun))).receipts[0].lines.map((l) => l.kubun);
    for (const c of ["114018370", "114042570"]) expect(one(c, "C001_N6_TERMINAL")).toEqual(["C001_N6_TERMINAL"]);
    for (const c of [rev.codes.F400_2.primary, ...rev.codes.F400_2.accept]) expect(one(c, "F400_2")).toEqual(["F400_2"]);
    for (const c of [rev.codes.F400_3.primary, ...rev.codes.F400_3.accept]) expect(one(c, "F400_3")).toEqual(["F400_3"]);
  });
});

describe("点検の対象外の単位がある請求（design.md §11-11 完了条件 (f)）と、見本以外で試す合成の UKE", () => {
  const extra = { taishogai: read(EXTRA.taishogai.file), kisaimore: read(EXTRA.kisaimore.file), kaiteimae: read(EXTRA.kaiteimae.file) };
  const k = (name: string) => loadCase(name);
  /** 取り込んだ UKE と同じ形の請求にする：カルテ側の記録なし。事実は、もとの症例のものを使う（突き合わせのため） */
  const ctxOf = (buf: Buffer, base: string) => {
    const file = readUke(buf, uploadClaimIdOf(1));
    const b = k(base);
    return { file, ctx: toClaimContext(file, "U1-1", { facility: b.facility, facts: b.facts, events: [], recordsKnown: false }) };
  };

  it("合成の 3 本は入力だけで決まり（作り直したものとファイルが一致）、見本の 2 本とは別のファイル。患者は見本の誰とも違う", () => {
    const out = generateExtra();
    expect(out.taishogai.equals(extra.taishogai)).toBe(true);
    expect(out.kisaimore.equals(extra.kisaimore)).toBe(true);
    expect(out.kaiteimae.equals(extra.kaiteimae)).toBe(true);
    const known = [...files.国保連.receipts, ...files.支払基金.receipts].map((r) => `${r.patient.name}|${r.patient.birth}|${r.patient.insurer.no}`);
    for (const buf of Object.values(extra)) {
      const p = parseUke(buf).claims[0].patient;
      expect(known).not.toContain(`${p.name}|${p.birth}|${p.insurer.no}`);
      expect(known.some((x) => x.startsWith(`${p.name}|`) || x.endsWith(`|${p.insurer.no}`))).toBe(false);
    }
  });

  it("対象外の行の例（EM 5-1）：扱っていないコードの加算と同じ単位にある往診料は、単位ごと対象外に残る。小計と UKE の合計は別に出て、total は null", () => {
    const u = EXTRA.taishogai.extraUnit;
    // 足した単位は、EM 5-1 の行のコードと点数
    expect(em).toContain(`${u.codes[0]}（往診料）・${u.codes[1]}（緊急往診加算「定める患者以外」）`);
    expect([u.codes[0], u.points]).toEqual([code("C000"), pts("C000") + 325]);
    expect(Object.values(rev.codes).some((c) => c.primary === u.codes[1] || c.accept.includes(u.codes[1]))).toBe(false);
    const { file, ctx } = ctxOf(extra.taishogai, EXTRA.taishogai.base);
    const r = file.receipts[0];
    const base = k(EXTRA.taishogai.base);
    // もとの症例の行はそのまま点検の対象。往診料は対応しているコードだが、同じ単位の加算を扱っていないので、行にしない
    expect(r.lines.map(({ kubun, count, dates }) => ({ kubun, count, dates }))).toEqual(base.lines);
    expect(r.others).toEqual([{ unit: r.lines.length, codes: u.codes, points: u.points, count: 1, days: Array.from({ length: 31 }, (_, i) => (i === u.day - 1 ? 1 : 0)) }]);
    expect(r.patientNo).toBe(EXTRA.taishogai.patientNo);
    const whole = evaluate(base).total!;
    expect(r.declared).toEqual({ ho: whole + u.points, ko: [] });
    expect(ctx.partial).toBe(true);
    const result = evaluate(ctx);
    expect([result.total, result.subtotal]).toEqual([null, whole]);
    // 訪問日の記載は訪問診療料の日だけ（往診の日はない）が、往診料の行が対象外にあるので、日付の突き合わせはしない。指摘は出ない
    expect(result.findings.filter((f) => f.kind !== "情報不足")).toEqual([]);
  });

  it("記載を欠いた例（EM 5-1）：必須の記載を 1 つ欠いた UKE は、その記載の記載もれが 1 件だけ出る。対象外の単位はなく、合計が出る", () => {
    const { file, ctx } = ctxOf(extra.kisaimore, EXTRA.kisaimore.base);
    expect(file.receipts[0].others).toBeUndefined();
    expect(ctx.partial).toBeUndefined();
    const result = evaluate(ctx);
    expect(result.total).toBe(evaluate(k(EXTRA.kisaimore.base)).total);
    expect("subtotal" in result).toBe(false);
    expect(result.findings.filter((f) => f.kind !== "情報不足").map((f) => [f.messageKey, f.kind, f.params?.rule, f.lineRefs])).toEqual([["R17.comment_missing", "記載もれ", "T216-spo2", ["C103_2"]]]);
    expect(file.receipts[0].comments.some((c) => c.code === EXTRA.kisaimore.dropComment)).toBe(false);
  });

  it("改定前の診療年月の例（EM 5-1。design.md §11-12 完了条件 (b)）：診療年月に版がないので、取り込みでは区分に引かない。最新の版で引くと、点数の違いが単位ごとに並ぶ", () => {
    const o = EXTRA.kaiteimae;
    const ym = month(-o.monthsBack);
    expect(hasRevision(ym)).toBe(false);
    const parsed = parseUke(extra.kaiteimae);
    const c = parsed.claims[0];
    expect([c.yearMonth, parsed.billingMonth, c.patientNo, c.comments]).toEqual([ym, month(1 - o.monthsBack), o.patientNo, []]);
    // 行は、もとの症例から drop の区分を除いたもの。コードは基準月の版と同じ、点数は令和6年度の版（EM §2-9）。傷病名は未コード化で名称を持つ
    const old = revisionById(o.pointsOf)!;
    const kept = k(o.base).lines.filter((l) => !o.drop.includes(l.kubun));
    expect(kept.length).toBe(k(o.base).lines.length - o.drop.length);
    expect(c.units.map((u) => [u.items.map((it) => it.code), u.points, u.count])).toEqual(kept.map((l) => [[code(l.kubun)], old.points[l.kubun].points, l.count]));
    expect(c.patient.diseases.map((d) => [d.name !== "", d.code])).toEqual(c.patient.diseases.map(() => [true, undefined]));
    // 合計は EM 5-1 の行の数（6,013）。令和6年度の訪問診療料は 888、ベースアップ評価料(Ⅰ) 訪問診療時イは 28
    expect([c.total?.points, old.points.C001_1I.points, old.points.O001_3I.points]).toEqual([6013, 888, 28]);
    expect(em).toMatch(/\| kaiteimae\.UKE \| K2 \|.*HO の合計 \*\*6,013\*\*/);
    // 取り込みでは断らず、版のないレセプトとして残る
    const r = readUke(extra.kaiteimae, uploadClaimIdOf(1)).receipts[0];
    expect([r.claimId, r.noRevision, r.lines, r.declared]).toEqual(["U1-1", true, [], { ho: 6013, ko: [] }]);
    // 診療年月の版として読む読み方（取り込み）では、点数の違う単位は食い違いのまま
    expect(mapClaim(c, rev).units.filter((u) => !u.ok)).toHaveLength(2);
    // 試算の読み方：最新の版で、断らずに全部の行を引き、違う単位に版の点数を添える
    const latest = UKE_TRIAL_REVISIONS.at(-1)!;
    const diffsIn = (r8: Revision) => {
      const m = mapClaim(c, r8, true);
      expect([m.units.every((u) => u.ok), m.others, m.lines.map((l) => l.kubun)]).toEqual([true, [], kept.map((l) => l.kubun)]);
      return m.units.flatMap((u, i) => (u.ok && u.revPoints !== undefined ? [[u.lines.map((l) => l.kubun), c.units[i].points, u.revPoints, c.units[i].count]] : []));
    };
    expect(diffsIn(rev)).toEqual([[["C001_1I"], 888, 890, 2], [["O001_3I"], 28, 79, 2]]);
    expect(diffsIn(latest)).toEqual([[["C001_1I"], 888, pointsOf(latest, "C001_1I"), 2], [["O001_3I"], 28, pointsOf(latest, "O001_3I"), 2]]);
  });

  it("試算の読み方（lenient）：複数の区分がある単位は、区分ごとに分けず、単位の合算どうしを比べる。点数のほかの食い違いの単位は、点検の対象外に残す。既定の読み方は変わらない", () => {
    const sum = pts("C000") + pts("C000_N1_KINKYU");
    const two = parseUke(ukeOf([si("14", code("C000")), si("", code("C000_N1_KINKYU"), { points: sum - 5 })], sum - 5)).claims[0];
    const m = mapClaim(two, rev, true);
    expect(m.units).toEqual([{ ok: true, lines: [expect.objectContaining({ kubun: "C000" }), expect.objectContaining({ kubun: "C000_N1_KINKYU" })], revPoints: sum }]);
    expect(mapClaim(two, rev).units[0]).toMatchObject({ ok: false, unsupported: false });
    // 数量データが読めない単位（きざみで算定する区分）：試算では対象外の単位として残り、行には入らない
    const q = parseUke(ukeOf([si("60", code("D_GAIRAI_JINSOKU"), { points: pts("D_GAIRAI_JINSOKU") })], pts("D_GAIRAI_JINSOKU"))).claims[0];
    expect(mapClaim(q, rev).others).toEqual([]);
    expect(mapClaim(q, rev, true)).toMatchObject({ lines: [], others: [{ unit: 0, codes: [code("D_GAIRAI_JINSOKU")] }] });
    // 見本のレセプトは、どちらの読み方でも同じ（点数の違いはない）
    for (const claim of parseUke(read(UKE_FILES.国保連)).claims) expect(mapClaim(claim, rev, true)).toEqual(mapClaim(claim, rev));
  });

  it("UKE の試算で選べる版は、コードの表を持つ版だけ（design.md §11-12 完了条件 (e)）：令和6年度の版（コードの表が空）は入らない", () => {
    expect(UKE_TRIAL_REVISIONS.map((r) => r.id)).toEqual(["r2026", "r2027-06"]);
    expect(Object.keys(revisionById("r2024")!.codes)).toEqual([]);
    // 仮に選べたとすると、全部の単位が対象外になり、行が 1 つも残らない（空の結果が「問題なし」に見える）
    const all = mapClaim(parseUke(extra.kaiteimae).claims[0], revisionById("r2024")!, true);
    expect([all.lines, all.others.length]).toEqual([[], all.units.length]);
  });
});

describe("保存済みのレセプトの読み直し（design.md §11-12 完了条件 (f)）", () => {
  // 取り込んだ後に点数表が変わった、と見立てる：看取り加算（K5 だけが算定している）の点数を変えた版
  const changed: Revision[] = [{ ...rev, points: { ...rev.points, C001_N7_MITORI: { ...rev.points.C001_N7_MITORI, points: pts("C001_N7_MITORI") + 1 } } }];
  const buf = read(UKE_FILES.国保連);

  it("表が変わって点数が合わなくなったレセプトが 1 件あっても、例外にせず、そのレセプトだけが unreadable（理由つき）になる。ほかのレセプトは今までどおり読める", () => {
    const stored = readStoredUke(buf, undefined, changed);
    expect(stored.receipts.map((r) => [r.claimId, r.unreadable?.reason ?? null])).toEqual([
      [claimId("K1"), null],
      [claimId("K2"), null],
      [claimId("K3"), null],
      [claimId("K4"), null],
      [claimId("K5"), UNREADABLE.changed],
      [claimId("K7"), null],
    ]);
    expect(UNREADABLE.changed).toBe("取り込んだ後に表が変わり、点数が合わなくなりました");
    const k5 = stored.receipts[4];
    expect([k5.lines, k5.comments, k5.patient.name !== ""]).toEqual([[], [], true]);
    // 読めたレセプトは、表が変わる前と同じ
    expect(stored.receipts.filter((r) => !r.unreadable)).toEqual(files.国保連.receipts.filter((r) => r.claimId !== claimId("K5")));
  });

  it("同じファイルを、表が変わったあとに取り込もうとすると、今までどおり行番号つきで断る（断るのは取り込みの時だけ）", () => {
    expect(() => readUke(buf, undefined, changed)).toThrow(/^\d+ 行目：点数が診療年月の版の点数表と合わない$/);
  });

  it("表が変わっていなければ、読み直しは取り込みと同じ結果。診療年月に版がなくなったレセプトは、読めないのではなく「版のないレセプト」として残る", () => {
    expect(readStoredUke(buf)).toEqual(files.国保連);
    expect(readStoredUke(buf, undefined, []).receipts.map((r) => [r.noRevision, r.unreadable, r.lines.length])).toEqual(Array.from({ length: 6 }, () => [true, undefined, 0]));
  });

  it("形式そのものが読めないファイルは、読み直しでも UkeError（ファイルごと読めない）", () => {
    expect(() => readStoredUke(buf.subarray(0, -1))).toThrow(UkeError);
  });
});

describe("書き出し → 読み取りの往復（§11-14 完了条件 (c)）", () => {
  const { cases, src } = loadSources();
  const byId = (k: string) => cases.find((c) => c.claimId === claimId(k))!;
  const roundTrip = (file: UkeFile) => readUke(writeUke(file));

  it("K1〜K7：区分・回数・日付・合計が同じ", () => {
    const built = buildUkeFiles(cases, src, BILLING_MONTH);
    for (const payer of ["国保連", "支払基金"] as const) {
      const back = roundTrip(built[payer]);
      expect(back.receipts.map((r) => r.lines)).toEqual(built[payer].receipts.map((r) => r.lines));
      // 必須のコメント（§11-13）も、コードと文字データが同じまま戻る（UKE の中の並びは行の順なので、並びは問わない）
      const pairs = (f: UkeFile) => f.receipts.map((r) => r.comments.map((c) => `${c.code} ${c.text} ${c.raw}`).sort());
      expect(pairs(back)).toEqual(pairs(built[payer]));
      // 読んだものを、もう一度書き出して読める（行は同じ。コメントは、単位の直後の CO に回った分がレセプト全体へのコメントになるので、置き場所だけが変わる）
      const again = roundTrip(back);
      expect(again.receipts.map((r) => r.lines)).toEqual(back.receipts.map((r) => r.lines));
      expect(pairs(again)).toEqual(pairs(back));
    }
  });

  it("コメント：区分に付くコメントは SI のコメント欄に書かれ、同じ区分に付いて戻る。区分に付かないコメントはレセプト全体へのコメントになる。文字データは原文のまま", () => {
    const comments = [
      comment("820000001", ""),
      comment("830000001", "全体へのコメント　２件目", [], "全体へのコメント　2件目"),
      comment("842100044", "９６", ["D008_19"], "96"),
      comment("830000002", "判断料へのコメント", ["D026_5"]),
    ];
    const file = buildUkeFiles([{ ...byId("K6"), comments }], src, BILLING_MONTH).支払基金;
    const text = formatUke(file);
    expect(text.split("\r\n").filter((l) => l.startsWith("CO,"))).toEqual(["CO,01,1,820000001,", "CO,,1,830000001,全体へのコメント　２件目"]);
    expect(text).toContain(`SI,60,1,${code("D008_19")},,130,1,842100044,９６,`);
    const back = roundTrip(file).receipts[0];
    expect(back.comments).toEqual(comments);
    expect(back.lines).toEqual(byId("K6").lines);
  });

  it("コメント：1 つの単位に 4 件以上あると、4 件目からは単位の直後の CO に書く（読み戻すと on は空。形式から帰属が決まらない置き場所）", () => {
    const many = [1, 2, 3, 4].map((n) => comment(`81000000${n}`, `コメント${n}`, ["D008_19"]));
    const back = roundTrip(buildUkeFiles([{ ...byId("K6"), comments: many }], src, BILLING_MONTH).支払基金).receipts[0];
    expect(back.comments).toEqual([...many.slice(0, 3), { ...many[3], on: [] }]);
  });

  it("注加算は基本の項目と同じ単位に書き、合算の点数を最後の行に書く。きざみで算定する区分は、同じ日に重ねた回数を数量データに書く", () => {
    const lines = [
      { kubun: "C000", count: 1, dates: [day(14)] },
      { kubun: "C000_N1_KINKYU", count: 1, dates: [day(14)] },
      { kubun: "D_GAIRAI_JINSOKU", count: 4, dates: [day(14), day(14), day(21), day(21)] },
    ];
    const file = buildUkeFiles([{ ...byId("K6"), lines }], src, BILLING_MONTH).支払基金;
    const rows = formatUke(file).split("\r\n").filter((l) => l.startsWith("SI,")).map((l) => l.split(",").slice(0, 7));
    expect(rows).toEqual([
      ["SI", "14", "1", code("C000"), "", "", "1"],
      ["SI", "", "1", code("C000_N1_KINKYU"), "", String(pts("C000") + pts("C000_N1_KINKYU")), "1"],
      ["SI", "60", "1", code("D_GAIRAI_JINSOKU"), "2", String(pts("D_GAIRAI_JINSOKU") * 2), "2"],
    ]);
    expect(roundTrip(file).receipts[0].lines).toEqual(lines);
  });

  it("在宅ターミナルケア加算の書き出しは、居住の場所が施設ならロのコード。読み戻すと同じ区分", () => {
    const k5 = byId("K5");
    const at = (residence: "居宅" | "施設入居等") => {
      const file = buildUkeFiles([{ ...k5, facts: { ...k5.facts, residence: { known: true, value: residence } } }], src, BILLING_MONTH).国保連;
      const codes = formatUke(file).split("\r\n").filter((l) => l.startsWith("SI,")).map((l) => l.split(",")[3]);
      expect(roundTrip(file).receipts[0].lines).toEqual(k5.lines);
      return codes.filter((c) => ["114018370", "114042570"].includes(c));
    };
    expect(at("居宅")).toEqual(["114018370"]);
    expect(at("施設入居等")).toEqual(["114042570"]);
  });
});

describe("審査支払機関は保険証（保険者番号）で決まる", () => {
  it("6 桁（国保）と 39 で始まる 8 桁（後期）は国保連、それ以外の 8 桁（社保）は支払基金。形式が違えば例外", () => {
    expect(payerOfInsurer("139999")).toBe("国保連");
    expect(payerOfInsurer("39139999")).toBe("国保連");
    expect(payerOfInsurer("01139999")).toBe("支払基金");
    expect(payerOfInsurer("06139999")).toBe("支払基金");
    expect(() => payerOfInsurer("1234")).toThrow(/形式/);
  });

  it("K1〜K5 と K7 は後期高齢者で国保連、K6 は協会けんぽで支払基金", () => {
    const { cases, src } = loadSources();
    expect(cases.map((c) => [c.claimId, payerOfInsurer(src.patients[c.claimId].insurer.number)])).toEqual([
      [claimId("K1"), "国保連"], [claimId("K2"), "国保連"], [claimId("K3"), "国保連"], [claimId("K4"), "国保連"], [claimId("K5"), "国保連"], [claimId("K6"), "支払基金"], [claimId("K7"), "国保連"],
    ]);
  });

  it("請求の審査支払機関が保険証と食い違うと UKE を作らない", () => {
    const { cases, src } = loadSources();
    const k6 = { ...cases.find((c) => c.claimId === claimId("K6"))!, payer: "国保連" as const };
    expect(() => buildUkeFiles([k6], src, BILLING_MONTH)).toThrow(/保険証/);
  });
});
