// 実データ（masters.db）で確かめる、段 13 の完了条件（design.md §12-6・§12-7）：G07（必須コメント）・G08（傷病名の要件）の、当たる側・当たらない側・広く掛ける検査と、手書きの R17・R06 との重なり。
// データは同梱しないので、環境変数 RESEMEN_MASTER_DIR（masters.db のあるフォルダ）があるときだけ動く。ないときは飛ばし、飛ばした数を表示する（黙って通さない）
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import { evaluateGeneric } from "../../src/generic";
import { commentGroupsOf } from "../../src/generic/g07";
import type { GenericAboutMore, GenericClaim } from "../../src/generic/types";
import { openMasters, pickSnapshot } from "../../src/masters/db";
import { readEm, verifyMasters } from "../../src/masters/verify";
import { YM } from "../helpers/period";
import { checkUke, claimsOf, D, K } from "./small-comments";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
const root = path.join(__dirname, "..", "..");
let skipped = 0;
const withData = (name: string, fn: () => void, timeout?: number) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn, timeout);
};

const rev = resolveRevision(YM);
const about: GenericAboutMore = { yearMonth: YM, generation: rev.generation, outpatient: true };
type Kind = "SI" | "IY" | "TO";
const claimOf = (items: [Kind, string][], comments: string[] = []): GenericClaim => ({ units: items.map(([kind, code]) => ({ items: [{ kind, code }] })), comments: comments.map((code) => ({ code })) });
const note = (text: string) => console.log(text);

describe("段 13：実データの masters.db で", () => {
  withData("錨（EM §2-11。原文で確かめた事実）が全部通り、G07・G08 の準備ができている", () => {
    const db = openMasters(file)!;
    const em = readEm(root);
    const r = verifyMasters(db, em, { write: false });
    expect(r.lines.filter((l) => /が外れた|件数が違う|食い違う/.test(l))).toEqual([]);
    expect(r.failures).toBe(0);
    expect(em.anchors.filter((a) => a.table === "comment_kanren").length).toBeGreaterThanOrEqual(15);
    expect(em.anchors.filter((a) => a.table === "shobyo").length).toBeGreaterThanOrEqual(6);
    expect(r.ready.filter((x) => x.check === "G07" || x.check === "G08").map((x) => [x.check, x.ready, x.reason])).toEqual([["G07", true, ""], ["G08", true, ""]]);
    db.close();
  });

  withData("G07 当たる側：錨の組（EM §2-10 の 8 行の外）で、コメントを付けない合成のレセプトに出る。付けると出ない", () => {
    const db = openMasters(file)!;
    const g07 = (c: GenericClaim) => evaluateGeneric(c, db, about).findings.filter((f) => f.check === "G07");
    // [行の種類, コード, 錨のコメントコード（その組が要る）]
    const cases: [Kind, string, string][] = [["SI", K.kokyu, K.kokyuStart], ["SI", K.echo, K.echoA], ["SI", K.tokubetsu, K.jusho], ["SI", K.tokubetsu, K.jikan], ["SI", K.enkaku, K.zenkai], ["SI", K.ninchi, K.ninchiDate], ["IY", K.adtralza, K.ishi], ["TO", K.inatsu, K.shochi]];
    for (const [kind, code, comment] of cases) {
      const groups = commentGroupsOf(claimOf([[kind, code]]), db, about) as { groups: { comments: string[] }[] };
      const mine = groups.groups.find((g) => g.comments.includes(comment))!;
      expect(mine, `${code} ${comment}`).toBeDefined();
      // 付けない：その行為の、必ず要る記載の組が全部出る（錨の組を含む）。どれも条件つき
      const none = g07(claimOf([[kind, code]]));
      expect(none.map((f) => f.params.comments), code).toEqual(groups.groups.map((g) => g.comments.join(",")));
      expect(none.every((f) => f.certainty === "条件つき" && f.codes[0] === code)).toBe(true);
      // 錨のコメントだけ付ける：その組だけが消える
      expect(g07(claimOf([[kind, code]], [comment])).map((f) => f.params.comments), code).toEqual(groups.groups.filter((g) => g !== mine).map((g) => g.comments.join(",")));
      // 組ごとに 1 つずつ付ける：出ない
      expect(g07(claimOf([[kind, code]], groups.groups.map((g) => g.comments[g.comments.length - 1]))), code).toEqual([]);
    }
    // 両方とも要る記載（別の枝番）と、どちらか一方（同じ枝番）
    expect(g07(claimOf([["SI", K.tokubetsu]], [K.jusho])).map((f) => f.params.comments)).toEqual([K.jikan]);
    expect(g07(claimOf([["SI", K.enkaku]], [K.shokai]))).toEqual([]);
    // 条件が文章にある行（往診料の理由）・算定しなかった場合のコメント（初診料）は、言わない
    expect(g07(claimOf([["SI", K.oushin], ["SI", K.shoshin]]))).toEqual([]);
    db.close();
  });

  withData("当たらない側：同梱の UKE 全部で、重ねたあとに出る G07・G08 が 0 件。kisaimore.UKE は R17 と G07 が合わせて 1 件（2 回言わない）", () => {
    const db = openMasters(file)!;
    const files = readdirSync(path.join(root, "fixtures", "uke")).filter((n) => n.endsWith(".UKE"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    let claims = 0;
    const raw: string[] = [];
    for (const name of files)
      claimsOf(name).forEach((c, i) => {
        claims++;
        const r = checkUke(c, db);
        expect(r.result.ran.map((x) => x.check)).toEqual(expect.arrayContaining(["G07", "G08"]));
        expect([name, i, r.shown]).toEqual([name, i, []]);
        for (const f of r.generic) raw.push(`${name} #${i + 1} ${f.check} ${f.codes.join()} 項番${f.params.kouban ?? ""}`);
        if (name === "kisaimore.UKE") {
          // R17 が 1 件、G07 の同じ記載（在宅酸素の飽和度）は「手書きの指摘と同じ内容」として出さない
          expect(r.hand.findings.filter((f) => f.kind === "記載もれ").map((f) => f.messageKey)).toEqual(["R17.comment_missing"]);
          expect([r.generic.map((f) => f.codes), r.duplicate, r.judged]).toEqual([[[K.sanso]], 1, 0]);
        } else {
          expect([name, i, r.hand.findings.filter((f) => f.kind === "記載もれ")]).toEqual([name, i, []]);
        }
      });
    expect(claims).toBeGreaterThanOrEqual(10);
    // 重ねる前に G07・G08 が出したもの：kisaimore.UKE の 1 件だけ（手引きの記録例を組んだ jitsurei.UKE でも 0 件）
    expect(raw).toEqual([`kisaimore.UKE #1 G07 ${K.sanso} 項番216`]);
    db.close();
  });

  withData("R17 の表（EM §2-10 表 1）と関連テーブル：版の表のコードについて、G07 が使う組は、どれも R17 の「算定すれば必ず」の行と同じ記載（G07 だけが言う組はない）", () => {
    const db = openMasters(file)!;
    const only: string[] = [];
    let covered = 0;
    for (const [kubun, def] of Object.entries(rev.codes))
      for (const code of [def.primary, ...def.accept]) {
        const r = commentGroupsOf(claimOf([["SI", code]]), db, about) as { groups: { kouban: string; comments: string[] }[] };
        for (const g of r.groups) {
          const same = rev.comments.some((c) => c.when === "always" && c.kubun.includes(kubun) && c.codes.some((x) => g.comments.includes(x)));
          if (same) covered++;
          else only.push(`${kubun} ${code} 項番${g.kouban} ${g.comments.join()}`);
        }
      }
    // 食い違う組が出たら、関連テーブルの行が本当に「算定すれば必ず」かを、別表Ⅰ の原文で確かめる（黙って通さない）
    expect(only).toEqual([]);
    expect(covered).toBeGreaterThanOrEqual(8);
    note(`R17 の表と関連テーブル：版の表のコードで G07 が使う組 ${covered}。どれも R17 の「算定すれば必ず」の行と同じ記載`);
    db.close();
  });

  withData(
    "広く掛ける検査：関連テーブルに行のある全部のコードを 1 行ずつ置く。組ごとにコメントを 1 つ付けると 0 件、付けないと組の数だけ出る",
    () => {
      const db = openMasters(file)!;
      const snap = pickSnapshot(db, "comment_kanren", YM, rev.generation)!.snapshot;
      const rows = db.prepare("SELECT DISTINCT tsuchi, code FROM comment_kanren WHERE snapshot = ? AND tsuchi IN ('1', '5', '8')").all(snap) as { tsuchi: string; code: string }[];
      const kindOf: Record<string, Kind> = { "1": "SI", "5": "IY", "8": "TO" };
      let codes = 0;
      let groups = 0;
      let multi = 0;
      let notUsed = 0;
      const bad: string[] = [];
      for (const { tsuchi, code } of rows) {
        const kind = kindOf[tsuchi];
        const r = commentGroupsOf(claimOf([[kind, code]]), db, about) as { groups: { comments: string[] }[]; notUsed: number };
        notUsed += r.notUsed;
        if (r.groups.length === 0) continue;
        codes++;
        groups += r.groups.length;
        multi += r.groups.filter((g) => g.comments.length > 1).length;
        const none = evaluateGeneric(claimOf([[kind, code]]), db, about).findings.filter((f) => f.check === "G07");
        const all = evaluateGeneric(claimOf([[kind, code]], r.groups.map((g) => g.comments[0])), db, about).findings.filter((f) => f.check === "G07");
        if (none.length !== r.groups.length || all.length !== 0) bad.push(code);
      }
      note(`広く掛ける検査（コメント関連テーブル ${snap}）：行のあるコード ${rows.length}、必ず要る記載のあるコード ${codes}・組 ${groups}（うちコメントが複数ある組 ${multi}）、使わない組 ${notUsed}。付けないと全部出て、付けると 0 件`);
      expect(bad).toEqual([]);
      expect(codes).toBeGreaterThan(1500);
      // 診療行為を特定しない行（199999999 など）は、行為のコードとして置いても、必ず要る記載にならない（条件は文章）
      expect(evaluateGeneric(claimOf([["SI", "199999999"]]), db, about).findings.filter((f) => f.check === "G07")).toEqual([]);
      db.close();
    },
    300_000,
  );

  withData("G08：傷病名関連区分のある診療行為（3・4・5・7）は、対象の傷病名コードが SY になければ条件つきで出る。あれば出ない。難病外来（9）・未コード化は言わない", () => {
    const db = openMasters(file)!;
    const snap = pickSnapshot(db, "shinryo", YM, rev.generation)!.snapshot;
    const rows = db.prepare("SELECT code, shobyo_kanren FROM shinryo WHERE snapshot = ? AND shobyo_kanren <> '0' ORDER BY code").all(snap) as { code: string; shobyo_kanren: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(15);
    const hit: Record<string, string> = { "3": D.tenpousou, "4": D.taijou, "5": D.zensoku, "7": D.tenkan };
    const g08 = (code: string, diseases: string[]) => evaluateGeneric(claimOf([["SI", code]]), db, { ...about, diseases: diseases.map((d) => ({ code: d })) } as GenericAboutMore).findings.filter((f) => f.check === "G08");
    for (const { code, shobyo_kanren } of rows) {
      if (shobyo_kanren === "9") {
        expect(g08(code, [D.tounyou]), code).toEqual([]);
        continue;
      }
      expect(g08(code, [D.tounyou]).map((f) => [f.codes, f.certainty]), code).toEqual([[[code], "条件つき"]]);
      expect(g08(code, [D.tounyou, hit[shobyo_kanren]]), code).toEqual([]);
      expect(g08(code, [D.tounyou, "0000999"]), code).toEqual([]);
    }
    // 特定疾患療養管理料：高血圧症・２型糖尿病だけでは出る（令和6年度から対象外）。脳卒中後てんかん（08）は、特定疾患療養管理料でもてんかん指導料でも当たり
    expect(g08(K.tokutei, ["8833421", "2500015"]).length).toBe(1);
    expect([g08(K.tokutei, [D.nousotchuTenkan]), g08(K.tenkan, [D.nousotchuTenkan])]).toEqual([[], []]);
    // 傷病名関連区分のない行為（在宅時医学総合管理料）には言わない
    expect(g08(K.zaiisoukan, [D.tounyou])).toEqual([]);
    db.close();
  });

  it("データがないときは、飛ばした数を表示する（黙って通さない）", () => {
    if (!has) process.stderr.write(`段 13 の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
    expect(has ? 0 : skipped).toBe(has ? 0 : 6);
  });
});
