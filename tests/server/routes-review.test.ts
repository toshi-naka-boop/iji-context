// 査定・返戻の突き合わせ（spec FR-202 の I-1。design/iji-context/plan-i1.md の受け入れ条件）。実際のルート（app/api/review/**/route.ts）を呼んで確かめる。
// 同梱の合成の記録（fixtures/review/）を、デモのクリニックの見本の UKE（国保連・支払基金）と、取り込んだ合成の UKE（kisaimore・kaiteimae）に当てる。AI は呼ばない
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { autoConsent } from "../helpers/consent";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-review-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const auth = () => instance.getAuth();
const cookieOf = (u: User) => `resemen_session=${auth().createSession(u.id).token}`;
const get = (url: string, cookie: string) => new Request(`http://localhost${url}`, { headers: { cookie } });
const fixture = (name: string) => readFileSync(path.join(repo, "fixtures", "review", name));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Item = { id: number; kind: string; name: string; seikyu: string; jiyu: string[]; claimId: string | null; claimNote: string | null; line: string | null; confirmed: boolean; excluded: string | null; state: string };
type Detail = { id: number; claimId: string | null; line: string | null; lineBy: string | null; confirmed: boolean; excluded: string | null; pending: string | null; claimLevel: boolean; claims: { claimId: string; nameMatch: boolean }[]; lines: { code: string; hit: boolean }[]; findings: { key: string; system: string; id: string; messageKey: string; certainty: string; codes: string[]; related: boolean }[]; revisionId: string | null; fingerprint: string; fixedFingerprint: string; judgments: unknown[] };
type Count = { items: number; receipts: number };

const api = {
  list: async (cookie: string) => (await import("../../app/api/review/route")).GET(get("/api/review", cookie)),
  upload: async (cookie: string, name: string, bytes: Buffer) => {
    const form = new FormData();
    form.set("file", new Blob([bytes as BlobPart]), name);
    return (await import("../../app/api/review/upload/route")).POST(new Request("http://localhost/api/review/upload", { method: "POST", headers: { cookie }, body: form }));
  },
  item: async (cookie: string, id: number) => (await import("../../app/api/review/items/[id]/route")).GET(get(`/api/review/items/${id}`, cookie), { params: Promise.resolve({ id: String(id) }) }),
  act: async (cookie: string, id: number, body: unknown) =>
    (await import("../../app/api/review/items/[id]/route")).POST(new Request(`http://localhost/api/review/items/${id}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) }),
  report: async (cookie: string) => (await import("../../app/api/review/report/route")).GET(get("/api/review/report", cookie)),
  del: async (cookie: string, sha256: string) => (await import("../../app/api/review/uploads/[sha256]/route")).DELETE(new Request(`http://localhost/api/review/uploads/${sha256}`, { method: "DELETE", headers: { cookie } }), { params: Promise.resolve({ sha256 }) }),
  rematch: async (cookie: string, sha256: string) => (await import("../../app/api/review/uploads/[sha256]/rematch/route")).POST(new Request(`http://localhost/api/review/uploads/${sha256}/rematch`, { method: "POST", headers: { cookie } }), { params: Promise.resolve({ sha256 }) }),
};
const ok = async <T>(res: Response | Promise<Response>): Promise<T> => {
  const r = await res;
  const body = await r.json();
  expect([r.status, body]).toEqual([200, expect.anything()]);
  return body as T;
};

/** DB の全表の中身（監査ログを除く） */
function dump(dbFile: string): Record<string, string> {
  const db = new Database(dbFile, { readonly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    return Object.fromEntries(tables.filter((t) => t !== "audit_log").map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())]));
  } finally {
    db.close();
  }
}

const FILES = { kokuho: "RIzogn2131999999950811.csv", kikin: "RIzogn1131999999950811.csv", henrei: "RIhenr2131999999950811.csv", old: "RIzogn2131999999950804.csv" };

describe("査定・返戻の突き合わせ", () => {
  it("合成の記録を取り込むと、当たるものは請求と行に当たり、当たらないもの（番号の重なり・氏名の不一致・名称 0 個・2 個以上）は人が選ぶ欄に出る。選んで判定した報告の件数が正解の表と一致する", async () => {
    const owner = auth().register("review_owner", "やまだ", "password123");
    const me = instance.clerkIdOf(owner);
    const cookie = cookieOf(owner);
    const setRole = (role: Role) => auth().switchRole(owner, role);
    // 合成の UKE を取り込む（見本の 2 本はデモのクリニックの一覧にもとからある）。kisaimore は国保連・請求月 2026-11 のレセプト番号 1 で、見本の K1 と番号が重なる
    instance.runAs(owner, () => {
      const a = instance.getApp();
      a.uploadUke(me, readFileSync(path.join(repo, "fixtures", "uke", "kisaimore.UKE")));
      a.uploadUke(me, readFileSync(path.join(repo, "fixtures", "uke", "kaiteimae.UKE")));
    });

    // 権限：事務・医師は 403（事務長とベテランだけ）
    for (const role of ["clerk", "doctor"] as const) {
      setRole(role);
      expect([role, (await api.list(cookie)).status, (await api.upload(cookie, FILES.kokuho, fixture(FILES.kokuho))).status]).toEqual([role, 403, 403]);
    }
    setRole("veteran");
    for (const f of Object.values(FILES)) await ok(api.upload(cookie, f, fixture(f)));
    // 同じファイルの取り込み直しは断る。ファイル名の形が違えば断る
    expect((await api.upload(cookie, FILES.kokuho, fixture(FILES.kokuho))).status).toBe(409);
    const bad = await api.upload(cookie, "zogen.csv", fixture(FILES.kikin));
    expect([bad.status, (await bad.json()).error]).toEqual([400, expect.stringMatching(/ファイル名/)]);

    const list = await ok<{ fingerprint: string; uploads: { fingerprint: string }[]; items: Item[] }>(api.list(cookie));
    expect(list.items).toHaveLength(13);
    // 指紋は取り込んだときに固定してある（コードを変えていないので、今の指紋と同じ）
    expect(list.uploads.map((u) => u.fingerprint)).toEqual(Array(4).fill(list.fingerprint));
    const by = (name: string, seikyu = "") => list.items.find((i) => i.name === name && i.seikyu.startsWith(seikyu))!;
    const row = {
      k1: by("架空　一郎", "在医総管"),
      k1lab: by("架空　一郎", "血液化学"),
      k2: by("架空　二郎"),
      k3: by("架空　三郎", "訪問診療"),
      k3total: list.items.find((i) => i.name === "架空　三郎" && i.jiyu.includes("H"))!,
      masao: by("架空　正雄"),
      k4: by("架空　四朗"),
      k5: by("架空　五郎"),
      overlap: by("架空　十二郎"),
      k6: by("架空　六郎"),
      k7: by("架空　七郎"),
      unknown: by("架空　百子"),
      toshiko: by("架空　敏子"),
    };
    // 当たる側：請求と行（名称が 1 つに決まる行は自動、請求単位の明細は行に当てない）
    expect([row.k1, row.k1lab, row.k6, row.masao, row.k3total, row.k5, row.k7].map((i) => [i.claimId, i.line])).toEqual([
      ["K1-2026-10", "114032510"],
      ["K1-2026-10", "160017410"],
      ["K6-2026-10", "160162350"],
      ["U1-1", "114003710"],
      ["K3-2026-10", "請求単位"],
      ["K5-2026-10", "請求単位"],
      ["K7-2026-10", "請求単位"],
    ]);
    // 名称が 2 個以上・0 個の行は、請求には当たり、行は選ぶ欄に出る
    expect([row.k2, row.k3].map((i) => [i.claimId, i.line, i.state])).toEqual([["K2-2026-10", null, "unconfirmed"], ["K3-2026-10", null, "unconfirmed"]]);
    const k2 = await ok<Detail>(api.item(cookie, row.k2.id));
    expect(k2.lines.filter((l) => l.hit).map((l) => l.code)).toEqual(["114016070", "114043870"]);
    expect((await ok<Detail>(api.item(cookie, row.k3.id))).lines.filter((l) => l.hit)).toEqual([]);
    // 当たらない側：氏名の不一致・番号の重なり・該当なしは「当てられない」の理由つきで、請求を選ぶ欄に出る
    expect([row.k4, row.overlap, row.unknown].map((i) => [i.claimId, i.claimNote, i.state])).toEqual([
      [null, "氏名か保険者番号が合わない", "unmatched"],
      [null, "同じ請求月・同じレセプト番号の請求が 2 件以上ある（送信回をまたいで番号が重なる）", "unmatched"],
      [null, "保険者番号・氏名・診療年月の同じ請求がない", "unmatched"],
    ]);
    // 版のない診療年月の請求に当たったものは、対象外（分母から外す）
    expect([row.toshiko.claimId, row.toshiko.excluded]).toEqual(["U2-1", "版がない（2026年6月診療分より前など）"]);
    // 自動で当てた分も、人が確かめるまでは判定できない
    expect((await api.act(cookie, row.k1.id, { action: "judge", result: "指摘なし", reason: "決まりを作っていない" })).status).toBe(400);

    // 人が選ぶ：行（2 個以上・0 個）、請求（当てられなかったもの）、当てられない、対象外の印
    await ok(api.act(cookie, row.k2.id, { action: "line", line: "114016070" }));
    await ok(api.act(cookie, row.k3.id, { action: "line", line: "その他" }));
    expect((await api.act(cookie, row.k3.id, { action: "line", line: "999999999" })).status).toBe(400);
    const k4 = await ok<Detail>(api.item(cookie, row.k4.id));
    expect(k4.claims[0]).toMatchObject({ claimId: expect.any(String) });
    expect((await ok<Detail>(api.act(cookie, row.k4.id, { action: "claim", claimId: "K4-2026-10" }))).lineBy).toBe("auto");
    await ok(api.act(cookie, row.overlap.id, { action: "claim", claimId: null }));
    await ok(api.act(cookie, row.unknown.id, { action: "claim", claimId: null }));
    await ok(api.act(cookie, row.k5.id, { action: "exclude", reason: "再審査で戻った（復活）" }));
    for (const i of [row.k1, row.k1lab, row.k2, row.k3, row.k3total, row.masao, row.k4, row.k6, row.k7]) expect((await ok<Detail>(api.act(cookie, i.id, { action: "confirm" }))).confirmed).toBe(true);

    // 指摘のある行（kisaimore の在宅酸素療法指導管理料の記載もれ。R17）は、当てた行に関わる指摘として出て、「同じ論点で指摘していた」を選べる
    const masao = await ok<Detail>(api.item(cookie, row.masao.id));
    const r17 = masao.findings.find((f) => f.id === "R17")!;
    expect(r17).toMatchObject({ system: "ユスティ", certainty: "確定", related: true });
    expect(masao.revisionId).not.toBeNull();
    // 指摘していたときは、どの指摘かを選ぶ（理由は選ばない）。指摘しなかったときは、理由を選ぶ
    expect((await api.act(cookie, row.masao.id, { action: "judge", result: "同じ論点で指摘していた" })).status).toBe(400);
    expect((await api.act(cookie, row.k1.id, { action: "judge", result: "指摘なし" })).status).toBe(400);
    await ok(api.act(cookie, row.masao.id, { action: "judge", result: "同じ論点で指摘していた", finding: r17.key }));
    // 判定の記録には、系統・ID・文言の鍵・確度・コードだけを残す。指摘の文（記載の値を含むことがある）は残さない（X-322）
    const judged = ((await ok<Detail>(api.item(cookie, row.masao.id))).judgments.at(-1) as { finding: Record<string, unknown> | null }).finding;
    expect(judged).toEqual({ system: "ユスティ", id: "R17", messageKey: r17.messageKey, certainty: "確定", codes: r17.codes });
    expect(Object.keys(judged!)).not.toContain("text");
    // 指摘のない請求は、指摘を選べない（理由の選択を求められる）
    const k1 = await ok<Detail>(api.item(cookie, row.k1.id));
    expect(k1.findings.filter((f) => f.system !== "患者情報チェック")).toEqual([]);
    const judge = [
      [row.k1, "決まりを作っていない"],
      [row.k1lab, "審査の医学的な判断（規則にできない）"],
      [row.k2, "データがない（カルテ・構造化データ・患者の情報）"],
      [row.k3, "判定不能"],
      [row.k3total, "決まりはあるのに当たらなかった"],
      [row.k4, "人に聞く事実がない"],
      [row.k6, "審査の医学的な判断（規則にできない）"],
      [row.k7, "その他"],
    ] as const;
    for (const [i, reason] of judge) await ok(api.act(cookie, i.id, { action: "judge", result: "指摘なし", reason }));
    // 対象外・当てられないものは判定しない
    expect((await api.act(cookie, row.toshiko.id, { action: "judge", result: "指摘なし", reason: "その他" })).status).toBe(400);
    expect((await api.act(cookie, row.k5.id, { action: "judge", result: "指摘なし", reason: "その他" })).status).toBe(400);

    // 報告：正解の表と一致する（明細の件数が主、レセプトの件数を並べる。割合は出さない）
    const report = await ok<Record<string, unknown>>(api.report(cookie));
    const c = (items: number, receipts: number): Count => ({ items, receipts });
    expect(report).toEqual({
      total: c(13, 11),
      byKind: [{ kind: "zogen", count: c(11, 9) }, { kind: "henrei", count: c(2, 2) }],
      excluded: [
        { reason: "版がない（2026年6月診療分より前など）", count: c(1, 1) },
        { reason: "当てられない", count: c(2, 2) },
        { reason: "再審査で戻った（復活）", count: c(1, 1) },
      ],
      pending: { unmatched: c(0, 0), unconfirmed: c(0, 0) },
      target: c(9, 7),
      byJiyu: [
        { jiyu: "1234", count: c(1, 1) },
        { jiyu: "A", count: c(1, 1) },
        { jiyu: "B", count: c(1, 1) },
        { jiyu: "C", count: c(1, 1) },
        { jiyu: "D", count: c(4, 4) },
        { jiyu: "H", count: c(1, 1) },
      ],
      deductedPoints: 900 + 103 + 250 + 890 + 10 + 2400 + 100 + 130,
      runs: [
        {
          fingerprint: list.fingerprint,
          fixedAtImport: true,
          revisions: [masao.revisionId],
          judged: c(9, 7),
          unjudged: c(0, 0),
          same: { 確定: c(1, 1), 条件つき: c(0, 0), 患者情報: c(0, 0) },
          other: c(0, 0),
          none: c(8, 6),
          reasons: [
            { reason: "審査の医学的な判断（規則にできない）", count: c(2, 2) },
            { reason: "データがない（カルテ・構造化データ・患者の情報）", count: c(1, 1) },
            { reason: "人に聞く事実がない", count: c(1, 1) },
            { reason: "決まりを作っていない", count: c(1, 1) },
            { reason: "決まりはあるのに当たらなかった", count: c(1, 1) },
            { reason: "その他", count: c(1, 1) },
            { reason: "判定不能", count: c(1, 1) },
          ],
        },
      ],
      fingerprint: list.fingerprint,
    });
    // 報告に氏名・番号・請求 id は入らない
    expect(JSON.stringify(report)).not.toMatch(/架空|39139993|K1-2026-10|U1-1/);

    // 当て方を変えると、確かめた印とその明細の判定が外れる
    const changed = await ok<Detail>(api.act(cookie, row.k2.id, { action: "line", line: "114043870" }));
    expect([changed.confirmed, changed.judgments]).toEqual([false, []]);

    // 消す：取り込んだ CSV の単位。明細と判定が消え、その CSV にだけあった値（氏名・受付番号）がどの表にも残らない。監査ログには内容のハッシュだけ
    const dbFile = instance.tenantPaths(owner.tenantId).dbFile;
    const henreiSha = sha(fixture(FILES.henrei));
    setRole("clerk");
    expect((await api.del(cookie, henreiSha)).status).toBe(403);
    setRole("manager");
    expect(await ok(api.del(cookie, henreiSha))).toEqual({ deleted: henreiSha, items: 2 });
    expect((await api.del(cookie, henreiSha)).status).toBe(404);
    const after = dump(dbFile);
    for (const marker of ["架空　百子", "0003-00000001", henreiSha]) expect([marker, Object.keys(after).filter((t) => after[t].includes(marker))]).toEqual([marker, []]);
    expect((await ok<{ items: Item[] }>(api.list(cookie))).items).toHaveLength(11);
    const log = instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((l) => l.action.includes("/api/review/"));
    expect(log.find((l) => l.action === "DELETE /api/review/uploads/[sha256]" && l.result === "ok")).toMatchObject({ target: henreiSha });
    expect(JSON.stringify(log)).not.toMatch(/架空|39139993|0001-0000/);

    // UKE を消すと、その請求に当てた明細は当て方と判定が外れて「当てられない（選ぶ）」に戻る。当て直すと、残っている UKE で当て直す
    const kisaimore = readdirSync(path.join(path.dirname(dbFile), "uke")).find((f) => readFileSync(path.join(path.dirname(dbFile), "uke", f)).equals(readFileSync(path.join(repo, "fixtures", "uke", "kisaimore.UKE"))))!.replace(/\.UKE$/, "");
    expect((await (await import("../../app/api/uke/uploads/[sha256]/route")).DELETE(new Request(`http://localhost/api/uke/uploads/${kisaimore}`, { method: "DELETE", headers: { cookie } }), { params: Promise.resolve({ sha256: kisaimore }) })).status).toBe(200);
    const gone = dump(dbFile);
    expect(Object.keys(gone).filter((t) => /(?<![A-Za-z0-9-])U1-1(?![A-Za-z0-9-])/.test(gone[t]))).toEqual([]);
    const relisted = await ok<{ items: Item[] }>(api.list(cookie));
    expect(relisted.items.find((i) => i.id === row.masao.id)).toMatchObject({ claimId: null, state: "unmatched", confirmed: false });
    // 番号が重なっていた明細は、重なりがなくなっても人が「当てられない」と決めたので変えない。正雄の明細は当て直すと、番号の同じ見本の K1 に当たりかけて検算で外れる
    const rematched = await ok<{ items: Item[] }>(api.rematch(cookie, sha(fixture(FILES.kokuho))));
    expect(rematched.items.find((i) => i.id === row.overlap.id)).toMatchObject({ excluded: "当てられない" });
    expect(rematched.items.find((i) => i.id === row.masao.id)).toMatchObject({ claimId: null, claimNote: "氏名か保険者番号が合わない" });
  });
});
