// F4：合成 UKE 2 本（spec FR-05・FR-06、impl-plan 11/5 の完了条件）
import iconv from "iconv-lite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BILLING_MONTH, CASES, generate, loadSources, UKE_FILES } from "../../scripts/gen-uke";
import { evaluate } from "../../src/engine";
import { buildUkeFiles, toClaimContext } from "../../src/uke/cases";
import { formatUke, parseUke, writeUke } from "../../src/uke/uke";
import { loadCase } from "../engine/helpers";

const root = path.join(__dirname, "..", "..");
const read = (f: string) => readFileSync(path.join(root, f));
const files = { 国保連: parseUke(read(UKE_FILES.国保連)), 支払基金: parseUke(read(UKE_FILES.支払基金)) };

describe("2 本を読む", () => {
  it("IR=2（国保連）で K1〜K5、IR=1（支払基金）で K6。合わせて 6 件", () => {
    expect(read(UKE_FILES.国保連).toString("latin1").startsWith("IR,2,13,1,")).toBe(true);
    expect(read(UKE_FILES.支払基金).toString("latin1").startsWith("IR,1,13,1,")).toBe(true);
    expect(files.国保連.receipts.map((r) => r.claimId)).toEqual(["K1-2025-03", "K2-2025-03", "K3-2025-03", "K4-2025-03", "K5-2025-03"]);
    expect(files.支払基金.receipts.map((r) => r.claimId)).toEqual(["K6-2025-03"]);
    expect(files.国保連.billingMonth).toBe(BILLING_MONTH);
  });

  it("読んだレセプトとカルテ側の事実を合わせると、症例 JSON と同じ ClaimContext・同じ判定になる", () => {
    for (const k of CASES) {
      const want = loadCase(k);
      const file = want.payer === "国保連" ? files.国保連 : files.支払基金;
      const got = toClaimContext(file, want.claimId, { facility: want.facility, facts: want.facts, events: want.events, history: want.history });
      expect(got.lines).toEqual(want.lines);
      expect(got.comments).toEqual(want.comments ?? []);
      expect([got.yearMonth, got.payer, got.prefecture]).toEqual([want.yearMonth, want.payer, want.prefecture]);
      expect(evaluate(got)).toEqual(evaluate(want));
    }
  });

  it("K3 は公費（54）が 1 件目の KO に載り、負担区分は 2（医保＋公費①）", () => {
    const k3 = files.国保連.receipts.find((r) => r.claimId === "K3-2025-03")!;
    expect(k3.patient.kohi.map((x) => x.payerNo.slice(0, 2))).toEqual(["54"]);
    expect(k3.patient.receiptType).toBe("1328");
    const text = new TextDecoder("shift_jis").decode(read(UKE_FILES.国保連));
    const k3si = text.split("\r\n").slice(text.split("\r\n").findIndex((l) => l.includes("K3-2025-03"))).find((l) => l.startsWith("SI,"))!;
    expect(k3si.split(",")[2]).toBe("2");
  });

  it("K5 の主傷病の転帰は死亡（3）", () => {
    const k5 = files.国保連.receipts.find((r) => r.claimId === "K5-2025-03")!;
    expect(k5.patient.diseases[0]).toMatchObject({ name: "末期悪性腫瘍", main: true, outcome: 3 });
  });
});

describe("形式（FR-06）", () => {
  it("Shift_JIS・CRLF・末尾 EOF(0x1A)。レコード順は IR→(RE→HO/KO→SY→SI/CO)×n→GO", () => {
    for (const f of Object.values(UKE_FILES)) {
      const b = read(f);
      expect(b[b.length - 1]).toBe(0x1a);
      const text = new TextDecoder("shift_jis", { fatal: true }).decode(b.subarray(0, -1));
      expect(text.endsWith("\r\n")).toBe(true);
      expect(text.replaceAll("\r\n", "").includes("\n")).toBe(false);
      const kinds = text.slice(0, -2).split("\r\n").map((l) => l.slice(0, 2));
      expect(kinds.join(" ")).toMatch(/^IR( RE HO( KO)*( SY)+( SI( CO)*)+)+ GO$/);
    }
  });

  it("列数は IR 10・RE 38・HO 15・KO 12・SY 8・SI 44・GO 4", () => {
    const want: Record<string, number> = { IR: 10, RE: 38, HO: 15, KO: 12, SY: 8, SI: 44, CO: 5, GO: 4 };
    for (const f of Object.values(UKE_FILES)) {
      const text = new TextDecoder("shift_jis").decode(read(f).subarray(0, -1));
      for (const l of text.slice(0, -2).split("\r\n")) expect(l.split(",").length).toBe(want[l.slice(0, 2)]);
    }
  });

  it("書き出しは入力だけで決まる（作り直したものとファイルが一致）", () => {
    const out = generate();
    expect(out.国保連.equals(read(UKE_FILES.国保連))).toBe(true);
    expect(out.支払基金.equals(read(UKE_FILES.支払基金))).toBe(true);
  });

  it("CO は直前の SI の区分に付く（往復で保たれる）", () => {
    const { cases, src } = loadSources();
    const k6 = { ...cases.find((c) => c.claimId === "K6-2025-03")!, comments: [{ kubun: "D008_18", code: "820100001" }] };
    const back = parseUke(writeUke(buildUkeFiles([k6], src, BILLING_MONTH).支払基金));
    expect(back.receipts[0].comments).toEqual([{ kubun: "D008_18", code: "820100001" }]);
  });

  it("壊れた UKE は例外：EOF なし・GO の合計違い・算定日と回数の不一致・RE より前の SI", () => {
    const good = read(UKE_FILES.支払基金);
    expect(() => parseUke(good.subarray(0, -1))).toThrow(/EOF/);
    const text = new TextDecoder("shift_jis").decode(good.subarray(0, -1));
    const enc = (s: string) => Buffer.concat([iconv.encode(s, "Shift_JIS"), Buffer.from([0x1a])]);
    expect(() => parseUke(enc(text.replace(/GO,1,(\d+),99/, "GO,1,1,99")))).toThrow(/総合計点数/);
    expect(() => parseUke(enc(text.replace(/^(SI,60,1,\d+,,130,)1,/m, "$12,")))).toThrow(/回数/);
    expect(() => parseUke(enc(text.replace(/^RE,.*\r\nHO,.*\r\n/m, "")))).toThrow(/RE より前/);
  });

  it("書けない入力は例外：点数未収載の区分、診療年月の外の日付", () => {
    const { cases, src } = loadSources();
    const k6 = cases.find((c) => c.claimId === "K6-2025-03")!;
    const bad1 = { ...k6, lines: [...k6.lines, { kubun: "B000", count: 1, dates: ["2025-03-12"] }] };
    expect(() => formatUke(buildUkeFiles([bad1], src, BILLING_MONTH).支払基金)).toThrow(/点数未収載/);
    const bad2 = { ...k6, lines: [{ kubun: "D008_18", count: 1, dates: ["2025-04-01"] }] };
    expect(() => formatUke(buildUkeFiles([bad2], src, BILLING_MONTH).支払基金)).toThrow(/診療年月の外/);
  });
});
