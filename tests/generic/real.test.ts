// 実データ（masters.db）で確かめる、段 10b の完了条件（design.md §12-7）：行の名称・G01・ルールごとの partial。
// データは同梱しないので、環境変数 RESEMEN_MASTER_DIR（masters.db のあるフォルダ）があるときだけ動く。ないときは飛ばし、飛ばした数を表示する（黙って通さない）
import iconv from "iconv-lite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, partialBy } from "../../src/engine";
import { resolveRevision } from "../../src/engine/revisions";
import type { ClaimContext } from "../../src/engine/types";
import { evaluateGeneric } from "../../src/generic";
import { outsideOf, rowNamesOf, type RowNames } from "../../src/generic/lookup";
import type { GenericView } from "../../src/generic/view";
import { iyakuhinOf, openMasters, pickSnapshot, shinryoOf } from "../../src/masters/db";
import { mapClaim, parseUke } from "../../src/uke/uke";
import { loadCase } from "../engine/helpers";
import { autoConsent } from "../helpers/consent";
import { YM } from "../helpers/period";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
const root = path.join(__dirname, "..", "..");
let skipped = 0;
/** データがあるときだけ動くテスト */
const withData = (name: string, fn: () => void | Promise<void>) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn);
};

const rev = resolveRevision(YM);
const about = { yearMonth: YM, generation: rev.generation };
const end = `${YM.replace("-", "")}31`;
const sample = (name: string) => readFileSync(path.join(root, "fixtures", "uke", name));
const rowsOf = (b: Buffer) => new TextDecoder("shift_jis").decode(b.subarray(0, -1)).slice(0, -2).split("\r\n");
const ukeOf = (rows: string[]) => Buffer.concat([iconv.encode(`${rows.join("\r\n")}\r\n`, "Shift_JIS"), Buffer.from([0x1a])]);
/** 調査・批評が挙げた薬：変更年月日が 2026年10月より後（経過措置の期限を付けただけ） */
const DRUG_CHANGED_LATER = "610407003";
/** 尿・糞便等検査判断料（D026 の、版の表にないコード）。訪問診療料の代わりにはならない、関係のない行 */
const URINE_JUDGEMENT = "160061710";

describe("段 10b：実データの masters.db で", () => {
  withData("(a) fixtures/uke/jitsurei.UKE の全部の行（SI・IY・TO）に名称が付く。コメントコードと、表にない傷病名コードにも付く", () => {
    const db = openMasters(file)!;
    const claims = parseUke(sample("jitsurei.UKE")).claims;
    let rows = 0;
    for (const c of claims) {
      const items = c.units.flatMap((u) => u.items);
      const diseases = c.patient.diseases.flatMap((d) => (d.code ? [d.code] : []));
      const names = rowNamesOf(db, about, { items, comments: c.comments.map((x) => x.code), diseases });
      expect(items.filter((i) => !names.items[i.code]?.name).map((i) => `${i.kind}:${i.code}`)).toEqual([]);
      // 診療行為の行には、区分番号も付く（点数表にある行為）
      expect(items.filter((i) => i.kind === "SI" && !/^[A-Z]\d{3}(-\d+)?$/.test(names.items[i.code].no ?? "")).map((i) => i.code)).toEqual([]);
      expect(c.comments.filter((x) => !names.comments[x.code]).map((x) => x.code)).toEqual([]);
      expect(diseases.filter((d) => !names.diseases[d])).toEqual([]);
      rows += items.length;
    }
    expect(new Set(claims.flatMap((c) => c.units.flatMap((u) => u.items.map((i) => i.kind))))).toEqual(new Set(["SI", "IY", "TO"]));
    expect(rows).toBeGreaterThan(40);
    expect(claims.some((c) => c.patient.diseases.some((d) => d.code))).toBe(true);
    db.close();
  });

  withData("(b) 変更年月日が診療年月より後の薬を、2026年10月診療分に正しく使ったレセプト：G01 の指摘が出ない（jitsurei.UKE の 4 件も 0 件）", () => {
    const db = openMasters(file)!;
    const pick = pickSnapshot(db, "iyakuhin", YM, rev.generation)!;
    const row = iyakuhinOf(db, pick.snapshot, DRUG_CHANGED_LATER)!;
    expect(row).not.toBeNull();
    expect(row.changed_on > end).toBe(true);
    // jitsurei.UKE の 1 件目の薬を 1 つ、この薬に替える
    const rows = rowsOf(sample("jitsurei.UKE"));
    const i = rows.findIndex((l) => l.startsWith("IY,"));
    const cells = rows[i].split(",");
    cells[3] = DRUG_CHANGED_LATER;
    rows[i] = cells.join(",");
    const claim = parseUke(ukeOf(rows)).claims[0];
    expect(claim.units.flatMap((u) => u.items.map((x) => x.code))).toContain(DRUG_CHANGED_LATER);
    const r = evaluateGeneric(claim, db, { yearMonth: claim.yearMonth, generation: rev.generation });
    expect(claim.yearMonth).toBe(YM);
    expect([r.findings.filter((f) => f.check === "G01"), r.ran.map((x) => x.check).includes("G01")]).toEqual([[], true]);
    // 段 11：薬だけを替えて点数はそのままなので、検算（G02）がその単位に出る。使った行の変更年月日が診療年月より後なので、条件つき＋断り書き
    expect(r.findings.map((f) => [f.check, f.certainty, f.codes.includes(DRUG_CHANGED_LATER), f.params.later])).toEqual([["G02", "条件つき", true, "。この後にマスターが変更されています"]]);
    for (const c of parseUke(sample("jitsurei.UKE")).claims) expect(evaluateGeneric(c, db, about).findings).toEqual([]);
    db.close();
  });

  withData("(c) どの 1 枚にもないコードの行：条件つきの G01 が出る（言い切りでは出ない）", () => {
    const db = openMasters(file)!;
    const rows = rowsOf(sample("jitsurei.UKE"));
    for (const kind of ["SI", "IY", "TO"]) {
      const i = rows.findIndex((l) => l.startsWith(`${kind},`));
      const cells = rows[i].split(",");
      cells[3] = "100000000";
      rows[i] = cells.join(",");
    }
    const claim = parseUke(ukeOf(rows)).claims[0];
    const r = evaluateGeneric(claim, db, about);
    expect(r.findings.map((f) => [f.check, f.messageKey, f.certainty, f.codes, f.params.what])).toEqual(
      [...new Set(claim.units.flatMap((u) => u.items.filter((x) => x.code === "100000000").map((x) => x.kind)))].map((k) => ["G01", "G01.not_in_any", "条件つき", ["100000000"], { SI: "診療行為", IY: "医薬品", TO: "特定器材" }[k]]),
    );
    expect(r.findings.length).toBeGreaterThan(0);
    db.close();
  });

  /**
   * taishogai.UKE（在医総管 2ロ と、訪問診療料 2 回）から訪問診療料の行を除き、代わりに extra のコードの行を足したレセプトを、UKE のまま読んで判定する。
   * 足す行の点数は、マスターの点数（EM の採用値ではないので、ここに書かない）
   */
  const judged = (extra: string) => {
    const db = openMasters(file)!;
    const pick = pickSnapshot(db, "shinryo", YM, rev.generation)!;
    const rows = rowsOf(sample("taishogai.UKE")).filter((l) => !l.startsWith(`SI,14,1,${rev.codes.C001_1I.primary},`));
    const i = rows.findIndex((l) => l.startsWith("SI,"));
    // SI レコード（44 項目）：診療識別・負担区分・コード・数量・点数・回数、コメント 3 組、1〜31 日の回数（14 日に 1 回）
    const cells = Array.from({ length: 44 }, () => "");
    Object.assign(cells, { 0: "SI", 1: "60", 2: "1", 3: extra, 5: String(shinryoOf(db, pick.snapshot, extra)!.points), 6: "1", 26: "1" });
    rows.splice(i, 0, cells.join(","));
    const claim = parseUke(ukeOf(rows)).claims[0];
    const mapped = mapClaim(claim, rev);
    expect(mapped.lines.some((l) => rev.consts.visitKubun.includes(l.kubun))).toBe(false);
    expect(mapped.others.flatMap((o) => o.codes)).toContain(extra);
    const outside = outsideOf(db, rev, claim.yearMonth, mapped.others.flatMap((o) => o.codes));
    db.close();
    const ctx: ClaimContext = { ...loadCase("K1"), events: [], recordsKnown: false, lines: mapped.lines.map(({ kubun, count, dates }) => ({ kubun, count, dates })), comments: mapped.comments, commentsKnown: true, partial: true, outside };
    return { ctx, findings: evaluate(ctx).findings, v23: evaluate({ ...ctx, outside: undefined }).findings };
  };
  const r01 = (fs: ReturnType<typeof evaluate>["findings"]) => fs.filter((f) => f.ruleId === "R01").map((f) => (f.kind === "情報不足" ? `情報不足:${f.missing?.field}` : f.messageKey));

  withData("(d) 訪問診療料のない月の在医総管に、関係のない判断料（尿・糞便等検査判断料）の行があっても、R01 の「訪問診療料のない月」が出る（v23 の定義では止まっていた）", () => {
    const { ctx, findings, v23 } = judged(URINE_JUDGEMENT);
    expect(r01(findings)).toEqual(["R01.no_visit"]);
    expect(r01(v23)).toEqual(["情報不足:unsupportedLines"]);
    const rule = (id: string) => rev.rules.find((r) => r.id === id)!;
    expect(partialBy(rule("R01"), rev, ctx)).toBeNull();
    // 判断料を読むルール（R11）は、同じ区分番号（D026）なので止まる
    expect((partialBy(rule("R11"), rev, ctx) as { code: string }[]).map((x) => x.code)).toContain(URINE_JUDGEMENT);
  });

  withData("(e) 訪問診療料(Ⅱ) のような、R01 の読む区分と同じ区分番号の別コードがあると、R01 は partial になる。関係のないルールは止まらない", () => {
    const db = openMasters(file)!;
    const pick = pickSnapshot(db, "shinryo", YM, rev.generation)!;
    // 訪問診療料(Ⅰ) と同じ章・部・区分番号で、枝番が 2（C001-2）のコードを、マスターから 1 つ取る（点数のある基本の行）
    const base = shinryoOf(db, pick.snapshot, rev.codes.C001_1I.primary)!;
    const other = db.prepare("SELECT code FROM shinryo WHERE snapshot = ? AND sho = ? AND bu = ? AND kubun_no = ? AND eda = 2 AND point_kind = '3' AND chu_code = 0 ORDER BY code LIMIT 1").get(pick.snapshot, base.sho, base.bu, base.kubun_no) as { code: string } | undefined;
    db.close();
    expect(other).toBeDefined();
    const { ctx, findings } = judged(other!.code);
    expect(r01(findings)).toEqual(["情報不足:unsupportedLines"]);
    const stopped = rev.rules.filter((rule) => partialBy(rule, rev, ctx) !== null).map((rule) => rule.id);
    expect(stopped).toContain("R01");
    // 管理料の族（R16）・在宅移行早期加算（R14）・包括（R05）・指導管理料（R04）・処方（R06・R07）は、訪問診療料・往診料の区分番号を読まないので止まらない
    for (const id of ["R04", "R05", "R06", "R07", "R14", "R16"]) expect(stopped, id).not.toContain(id);
  });

  withData("取り込んだレセプトの点検のルート：jitsurei.UKE の対象外の行・コメント・傷病名に名称が付き、G01 が動いて指摘 0 件。対象外の行が医薬品だけのルールは止まらない", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "iji-generic-real-"));
    process.env.RESEMEN_DATA = tmp;
    process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
    try {
      const instance = await import("../../src/server/instance");
      autoConsent(instance.getAuth());
      const owner = instance.getAuth().register("generic_real", "やまだ", "password123");
      const cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
      const form = new FormData();
      form.set("file", new Blob([sample("jitsurei.UKE") as BlobPart]), "upload.UKE");
      expect((await (await import("../../app/api/uke/upload/route")).POST(new Request("http://localhost/api/uke/upload", { method: "POST", headers: { cookie }, body: form }))).status).toBe(200);
      const { GET } = await import("../../app/api/uke/claims/[claimId]/check/route");
      for (const id of ["U1-1", "U1-2", "U1-3", "U1-4"]) {
        const res = await GET(new Request(`http://localhost/api/uke/claims/${id}/check`, { headers: { cookie } }), { params: Promise.resolve({ claimId: id }) });
        expect([id, res.status]).toEqual([id, 200]);
        const c = (await res.json()) as { others: { codes: string[] }[]; comments: { code: string }[]; diseases: { code: string; name: string | null }[]; names: RowNames; generic: GenericView; stopped: { ruleId: string; all: boolean }[] };
        expect(c.others.flatMap((o) => o.codes).filter((code) => !c.names.items[code]), id).toEqual([]);
        expect(c.comments.filter((x) => !c.names.comments[x.code]), id).toEqual([]);
        expect(c.diseases.filter((d) => d.name === null), id).toEqual([]);
        expect([c.generic.ran.map((x) => x.check), c.generic.findings], id).toEqual([["G01", "G02", "G03"], []]);
      // 段 11：検算の数（対象外は、合っている側に数えない）と、していないことが、点検の範囲に付く
      expect(c.generic.scope!.recalc!.matched, id).toBe(c.generic.scope!.recalc!.checked);
      expect(c.generic.scope!.notDone, id).toHaveLength(1);
        expect(c.stopped.every((s) => !s.all), id).toBe(true);
        expect(c.stopped.length, id).toBeLessThan(rev.rules.length);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      delete process.env.RESEMEN_DATA;
      delete process.env.RESEMEN_WORKSPACES;
    }
  });

  it("データがないときは、飛ばした数を表示する（黙って通さない）", () => {
    if (!has) process.stderr.write(`段 10b の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
    expect(has ? 0 : skipped).toBe(has ? 0 : 6);
  });
});
