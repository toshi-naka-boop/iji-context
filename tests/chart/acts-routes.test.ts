// カルテの「行ったこと」のルート（design.md §15-6・15-7・15-9。段 18a）を実際に呼んで確かめる：取り出し → 当て方 → 候補・探す → 確かめて保存 → 前に選んだ対応。
// LLM は呼ばない（SDK の query を差し替える）。マスターは手で作った小さな表（tests/chart/small-chart-masters.ts）を RESEMEN_MASTER_DIR に置く
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartAct } from "../../src/chart/acts";
import { foldOfAct } from "../../src/chart/acts";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { resetLimits } from "../../src/server/rate-limit";
import { autoConsent } from "../helpers/consent";
import { claimId, day, YM } from "../helpers/period";
import { chartMasters } from "./small-chart-masters";

const llm = vi.hoisted(() => ({ runOnce: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), llm.runOnce));

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
const before = process.env.RESEMEN_MASTER_DIR;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-chart-acts-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  const dir = path.join(tmp, "masters");
  mkdirSync(dir);
  chartMasters(path.join(dir, "masters.db")).close();
  process.env.RESEMEN_MASTER_DIR = dir;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("acts_owner", "かるて", "password123", "demo");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
  if (before === undefined) delete process.env.RESEMEN_MASTER_DIR;
  else process.env.RESEMEN_MASTER_DIR = before;
});
beforeEach(() => {
  resetLimits();
  llm.runOnce.mockReset();
});

const get = (url: string, c: string | null = cookie) => new Request(`http://localhost${url}`, { headers: c ? { cookie: c } : {} });
const post = (url: string, body: unknown, c: string | null = cookie) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { ...(c ? { cookie: c } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
const setRole = (role: Role) => instance.getAuth().switchRole(user, role);

type Review = { dispensing: string; rxDefault: string; aliasCount: number; mastersPresent: boolean; matches: { act: { initial: { code: string; by: string } | null; candidates: { code: string; prior: boolean }[] }; with: { initial: { code: string; by: string } | null; candidates: { code: string }[] }[] }[] };
type Written = { id: number; date: string; facts: unknown[]; acts: ChartAct[]; rx: { quote: string }[]; actsDropped: { why: string }[]; review: Review };

const K11_NOTE = {
  s: "",
  o: "在宅患者訪問診療。",
  a: "",
  p: "関節腔内注射（左膝。キシロカイン注ポリアンプ０．５％　５ｍＬ、リンデロン注２ｍｇ（０．４％））。熱傷処置（ゲーベンクリーム１％ 20g）。やけど。",
  rx: "院内で投薬（ハルシオン０．２５ｍｇ錠）",
};
const K11_OUT = {
  facts: [],
  acts: [
    { category: "診療行為", written: "在宅患者訪問診療", lookup: ["在宅患者訪問診療料"], quote: "在宅患者訪問診療" },
    {
      category: "注射",
      written: "関節腔内注射",
      lookup: [],
      quote: "関節腔内注射（左膝。キシロカイン注ポリアンプ０．５％　５ｍＬ、リンデロン注２ｍｇ（０．４％））",
      with: [
        { kind: "薬", written: "キシロカイン注ポリアンプ０．５％　５ｍＬ", lookup: [], quote: "キシロカイン注ポリアンプ０．５％　５ｍＬ" },
        { kind: "薬", written: "リンデロン注２ｍｇ（０．４％）", lookup: [], quote: "リンデロン注２ｍｇ（０．４％）" },
      ],
    },
    { category: "処置", written: "熱傷処置", lookup: ["熱傷処置"], quote: "熱傷処置（ゲーベンクリーム１％ 20g）", with: [{ kind: "薬", written: "ゲーベンクリーム１％", lookup: [], quantity: "20g", quote: "ゲーベンクリーム１％ 20g" }] },
    { category: "処置", written: "やけど", lookup: ["熱傷処置"], quote: "やけど" },
    { category: "投薬", written: "ハルシオン０．２５ｍｇ錠", lookup: [], quote: "ハルシオン０．２５ｍｇ錠" },
  ],
  rx: [{ quote: "院内で投薬", form: "院外" }],
};

/** カルテを書く（取り出しの返事は out）。K11 は合成の症例にないので、訪問のある症例の請求に書く */
async function write(claim: string, note: typeof K11_NOTE, out: unknown): Promise<Written> {
  llm.runOnce.mockResolvedValueOnce({ structured: out, sessionId: "", stats: {} });
  const r = await (await import("../../app/api/chart/route")).POST(post("/api/chart", { claimId: claim, kind: "訪問診療", note }));
  expect(r.status).toBe(200);
  return (await r.json()) as Written;
}
const saveActs = async (body: unknown) => (await import("../../app/api/chart/acts/route")).POST(post("/api/chart/acts", body));
const savedActs = (id: number) => instance.runAs(user, () => instance.getApp().savedActs(id));
async function setDispensing(choice: string) {
  setRole("manager");
  const r = await (await import("../../app/api/facility/declaration/route")).POST(post("/api/facility/declaration", { item: "dispensing", fromMonth: YM, choice, checkedOn: day(13), recheckOn: "2027-01-13" }));
  expect(r.status).toBe(200);
  setRole("clerk");
}

describe("取り出しと当て方（POST /api/chart）", () => {
  it("行ったことと処方の記載を同じ 1 回の呼び出しで取り出し、手元でマスターに当てる。rx の form は捨て、初期値は処方の文から LLM を呼ばずに決まる", async () => {
    const w = await write(claimId("K4"), K11_NOTE, K11_OUT);
    expect(llm.runOnce).toHaveBeenCalledOnce();
    expect(w.rx).toEqual([{ quote: "院内で投薬" }]);
    expect(w.review).toMatchObject({ dispensing: "inside", rxDefault: "inside", aliasCount: 0, mastersPresent: true });
    const m = w.review.matches;
    expect(m[0].act.initial).toBeNull(); // 名前で当たらず、lookup の候補から選ぶ
    expect(m[0].act.candidates.map((c) => c.code)).toContain("114001110");
    // 注射の with の薬（K11 X27 のキシロカイン・リンデロン）は当てる一覧に出て、名前で当たる
    expect(m[1].with.map((x) => x.initial?.code)).toEqual(["620007260", "620002613"]);
    expect(m[2].with[0].initial?.code).toBe("620008991");
    expect(w.acts[2].with?.[0].quantity).toBe("20g");
    expect(m[3].act).toMatchObject({ initial: null, candidates: [{ code: "140032110" }] });
    // 送る文はカルテの文だけ（マスターの名称・コードは送らない）
    const sent = JSON.stringify(llm.runOnce.mock.calls[0][0]);
    expect(sent).not.toContain("140032110");
    expect(sent).not.toContain("熱傷処置（１００ｃｍ２以上");
    // 保存は本人の確かめのあと（ここではまだ確かめていない）
    expect(savedActs(w.id)).toBeNull();
  });
  it("確かめる画面の一覧は請求（管理料・UKE）によらない：同じカルテを管理料のある請求とない請求に書いても、当て方が同じ（C-233）", async () => {
    const a = await write(claimId("K1"), K11_NOTE, K11_OUT);
    const b = await write(claimId("K4"), K11_NOTE, K11_OUT);
    expect(a.review).toEqual(b.review);
  });
  it("申告の院内・院外が 3 つのどれでも、with の手技の薬は当てる一覧に出る（C-213）。投薬の薬は院外処方だけ・分からないでは見ない薬になる（C-221）", async () => {
    for (const d of ["outside", "unknown", "inside"]) {
      await setDispensing(d);
      const w = await write(claimId("K4"), K11_NOTE, K11_OUT);
      expect([d, w.review.dispensing, w.review.matches[1].with.map((x) => x.initial?.code)]).toEqual([d, d, ["620007260", "620002613"]]);
      const drug = w.review.matches[4].act.initial;
      expect([d, foldOfAct(w.acts[4], drug as never, w.review.dispensing as never, w.review.rxDefault as never)]).toEqual([d, d === "inside" ? "show" : "hidden"]);
    }
  });
});

describe("確かめて保存する（POST /api/chart/acts）", () => {
  it("量を直して保存して読み直すと同じ量が返る。本人が院内・院外を直すと rxChoiceBy が person、初期値のままなら rule。確かめたあとの 2 回目は 409", async () => {
    const w = await write(claimId("K4"), K11_NOTE, K11_OUT);
    const acts = w.acts.map((a, i) => ({ ...a, match: w.review.matches[i].act.initial, ...(a.with ? { with: a.with.map((c, j) => ({ ...c, match: w.review.matches[i].with[j].initial })) } : {}) }));
    acts[2].with![0].quantity = "30g";
    const r = await saveActs({ noteId: String(w.id), facts: [], acts, rx: w.rx, rxChoice: "outside" });
    expect(r.status).toBe(200);
    const s = savedActs(w.id)!;
    expect(s.acts[2].with?.[0]).toMatchObject({ quantity: "30g", match: { code: "620008991", by: "name" } });
    expect([s.rxChoice, s.rxChoiceBy]).toEqual(["outside", "person"]);
    expect((await saveActs({ noteId: String(w.id), facts: [], acts, rx: w.rx, rxChoice: "outside" })).status).toBe(409);
    const w2 = await write(claimId("K4"), K11_NOTE, K11_OUT);
    expect((await saveActs({ noteId: String(w2.id), facts: [], acts: [], rx: w2.rx, rxChoice: "inside" })).status).toBe(200);
    expect([savedActs(w2.id)!.rxChoice, savedActs(w2.id)!.rxChoiceBy]).toEqual(["inside", "rule"]);
  });
  it("当てたコードは、診療年月の 1 枚の category の表に実在するものだけ。引用がカルテにない行為は 400", async () => {
    const w = await write(claimId("K4"), K11_NOTE, K11_OUT);
    const bad = await saveActs({ noteId: String(w.id), facts: [], acts: [{ ...w.acts[3], match: { tbl: "iyakuhin", code: "620008991", name: "x", by: "candidate" } }], rx: [] });
    expect(bad.status).toBe(400);
    const gone = await saveActs({ noteId: String(w.id), facts: [], acts: [{ ...w.acts[3], match: { tbl: "shinryo", code: "160000190", name: "x", by: "search" } }], rx: [] });
    expect(gone.status).toBe(400);
    const notInNote = await saveActs({ noteId: String(w.id), facts: [], acts: [{ category: "処置", written: "創傷処置", lookup: [], quote: "創傷処置" }], rx: [] });
    expect(notInNote.status).toBe(400);
    expect(savedActs(w.id)).toBeNull();
  });
  it("前に選んだ対応（L-95）：選んだ「書かれた名前 → コード」が次のカルテで先頭に印つき・選んだ状態の初期値で出て、件数が出る。名前の完全一致が別のコードに 1 つあっても初期値は前に選んだもの。消した対応は初期値にならない（C-250）", async () => {
    const w = await write(claimId("K4"), K11_NOTE, K11_OUT);
    const pick = { tbl: "shinryo", code: "140032110", name: "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）", by: "candidate" };
    expect((await saveActs({ noteId: String(w.id), facts: [], acts: [{ ...w.acts[3], match: pick }], rx: [] })).status).toBe(200);
    expect(savedActs(w.id)!.acts[0].match).toEqual(pick);
    const next = await write(claimId("K4"), K11_NOTE, K11_OUT);
    expect(next.review.aliasCount).toBe(1);
    expect(next.review.matches[3].act.initial).toMatchObject({ code: "140032110", by: "alias" });
    expect(next.review.matches[3].act.candidates[0]).toMatchObject({ code: "140032110", prior: true });
    // 名前の完全一致（熱傷処置の名称どおり）があっても、本人が選んだ別のコードが初期値
    const named = { ...K11_NOTE, p: `${K11_NOTE.p}熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）。` };
    const out = { ...K11_OUT, acts: [{ category: "処置", written: "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）", lookup: [], quote: "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）" }] };
    const n1 = await write(claimId("K4"), named, out);
    expect(n1.review.matches[0].act.initial).toMatchObject({ code: "140032110", by: "name" });
    const other = { tbl: "shinryo", code: "140000610", name: "創傷処置（１００ｃｍ２未満）", by: "search" };
    expect((await saveActs({ noteId: String(n1.id), facts: [], acts: [{ ...n1.acts[0], match: other }], rx: [] })).status).toBe(200);
    const n2 = await write(claimId("K4"), named, out);
    expect(n2.review.matches[0].act.initial).toMatchObject({ code: "140000610", by: "alias" });
    expect(n2.review.matches[0].act.candidates.map((c) => [c.code, c.prior])).toEqual([["140000610", true], ["140032110", false]]);
    // 区分誤りの出た対応を消すと（点検を呼んだ側の処理）、初期値は名前の完全一致に戻り、消したコードは候補に残る
    const { forgotten } = instance.runAs(user, () => instance.getApp().forgetAliases([{ writtenNorm: "熱傷処置(100cm2以上500cm2未満)", tbl: "shinryo", code: "140000610" }]));
    expect(forgotten).toBe(1);
    const n3 = await write(claimId("K4"), named, out);
    expect(n3.review.aliasCount).toBe(0);
    expect(n3.review.matches[0].act.initial).toMatchObject({ code: "140032110", by: "name" });
  });
});

describe("候補・探す（GET /api/chart/acts/candidates・/api/masters/search）", () => {
  it("候補は実在するコードだけ。実在しない語では空で、名前で探せば出る。形の違う問い合わせは 400、未ログインは 401", async () => {
    const cand = (await import("../../app/api/chart/acts/candidates/route")).GET;
    const search = (await import("../../app/api/masters/search/route")).GET;
    const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const r = await cand(get(`/api/chart/acts/candidates?${q({ table: "shinryo", ym: YM, written: "やけど", lookup: "熱傷処置|存在しない語" })}`));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { candidates: { code: string }[] }).candidates.map((c) => c.code)).toEqual(["140032110"]);
    const none = (await (await cand(get(`/api/chart/acts/candidates?${q({ table: "shinryo", ym: YM, written: "存在しない語" })}`))).json()) as { initial: null; candidates: [] };
    expect(none).toEqual({ initial: null, candidates: [] });
    const found = (await (await search(get(`/api/masters/search?${q({ table: "shinryo", ym: YM, q: "熱傷" })}`))).json()) as { code: string; name: string; tbl: string }[];
    expect(found).toEqual([{ tbl: "shinryo", code: "140032110", name: "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）" }]);
    expect((await search(get(`/api/masters/search?${q({ table: "drug", ym: YM, q: "熱傷" })}`))).status).toBe(400);
    expect((await cand(get(`/api/chart/acts/candidates?${q({ table: "shinryo", ym: "2026-13", written: "x" })}`))).status).toBe(400);
    expect((await cand(get(`/api/chart/acts/candidates?${q({ table: "shinryo", ym: YM, written: "x" })}`, null))).status).toBe(401);
    expect((await search(get(`/api/masters/search?${q({ table: "shinryo", ym: YM, q: "x" })}`, null))).status).toBe(401);
  });
});
