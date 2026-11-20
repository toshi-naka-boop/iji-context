// 請求 id → 合成データのファイルの表引き（spec FR-108）。請求 id は UKE の中身から来るので、パスの組み立てに使わない
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { caseFileOf, chartFileOf } from "../../src/server/app/case-files";
import { createCases } from "../../src/server/app/cases";
import { createClaimFacts } from "../../src/server/app/claim-facts";
import { createClerks } from "../../src/server/app/clerks";
import { createClock } from "../../src/server/app/clock";
import { openContext } from "../../src/server/app/context";
import { createNotes } from "../../src/server/app/notes";
import { createPatients } from "../../src/server/app/patients";
import type { Uke } from "../../src/server/app/uke";
import type { UkeFile, UkePatient } from "../../src/uke/types";
import { claimId, day, month, YM } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-case-files-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** 前は fixtures/cases/<請求 id の頭>.json を開いていたので、これらは fixtures の別の場所や外のファイルを指せた */
const TRAVERSALS = [`../charts/K1-${YM}`, `../../config/demo-${YM}`, `..-${YM}`, `/etc/passwd-${YM}`, `K1/../K2-${YM}`, `K1.json-${YM}`, `k1-${YM}`, `K1\u0000-${YM}`, `__proto__-${YM}`, `constructor-${YM}`];

describe("請求 id からファイルを引く表", () => {
  it("表にある症例は、表に書いたファイルになる（K6 は合成カルテを持たない）", () => {
    expect(caseFileOf(repo, claimId("K1"))).toBe(path.join(repo, "fixtures", "cases", "K1.json"));
    expect(chartFileOf(repo, claimId("K7"))).toBe(path.join(repo, "fixtures", "charts", "K7.json"));
    expect(caseFileOf(repo, claimId("K6"))).not.toBeNull();
    expect(chartFileOf(repo, claimId("K6"))).toBeNull();
  });

  it("パスの区切り・.. ・表にない番号を含む請求 id は、どのファイルにもならない", () => {
    for (const id of [...TRAVERSALS, claimId("K8"), claimId("K17"), ""]) expect([id, caseFileOf(repo, id), chartFileOf(repo, id)]).toEqual([id, null, null]);
  });
});

describe("請求 id にパスを仕込んだ UKE が読み込まれても、外のファイルを開かない", () => {
  const person: UkePatient = { name: "架空　七郎", sex: 1, birth: "19540401", receiptType: "1118", insurer: { number: "01139997", symbol: "1", no: "00000007" }, kohi: [], diseases: [] };
  function setup(id: string) {
    const file: UkeFile = {
      payer: "支払基金",
      prefecture: "東京都",
      clinic: { code: "9999999", name: "架空在宅クリニック", phone: "0300000000" },
      billingMonth: month(1),
      receipts: [{ claimId: id, yearMonth: YM, patient: person, lines: [{ kubun: "C001_1I", count: 1, dates: [day(5)] }], comments: [], commentsKnown: true }],
    };
    const ctx = openContext({ root: repo, dbFile: path.join(tmp, "app.db"), knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills"), queryLogDir: path.join(tmp, "query-log") });
    const clock = createClock(ctx);
    const clerks = createClerks(ctx);
    const uke = { ukeFiles: () => [file], patientOf: () => person } as unknown as Uke;
    const cases = createCases(ctx, clock, uke, createPatients(ctx, clock, clerks, uke), createClaimFacts(ctx, clock, clerks, uke));
    return { ctx, cases, notes: createNotes(ctx, clock, clerks, uke, cases) };
  }

  it("症例の JSON：前はカルテの JSON（../charts/K1）を症例として開いていた。いまは開かず、負担割合は「ない」、症例の一覧では事実が「不明」のレセプトになる", () => {
    for (const id of TRAVERSALS) {
      const { ctx, cases } = setup(id);
      expect([id, cases.caseBurdenRatioOf(id)]).toEqual([id, null]);
      const [c] = cases.cases();
      expect([id, cases.isUploaded(id), c.facts.mainDisease, c.facts.burdenRatio, c.events, c.history]).toEqual([id, true, { known: false }, { known: false }, [], undefined]);
      ctx.sqlite.close();
    }
  });

  it("合成カルテ：前は症例の JSON（../cases/K1）をカルテとして開いていた。いまは開かず、カルテは「ない」", () => {
    for (const id of [`../cases/K1-${YM}`, ...TRAVERSALS]) {
      const { ctx, notes } = setup(id);
      expect([id, notes.chartOf(id)]).toEqual([id, null]);
      ctx.sqlite.close();
    }
  });
});
