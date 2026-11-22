// evaluateGeneric(claim, masters, about)：データで動く点検（design.md §12-2）。公開データ（masters.db）の行で、UKE の単位とコードのまま点検する。
// 手書きのルール（src/engine/ の evaluate）は変えない。指摘は定型文と値だけで作り、LLM は使わない。
// 入っているのは G01〜G09
import raw from "../../config/generic-checks.json";
import { checkReady, type MastersDb } from "../masters/db";
import { g01 } from "./g01";
import { g02 } from "./g02";
import { g03 } from "./g03";
import { g04 } from "./g04";
import { g05 } from "./g05";
import { g06 } from "./g06";
import { g07 } from "./g07";
import { g08 } from "./g08";
import { g09 } from "./g09";
import { FINDING_LIMIT, GENERIC_CHECKS, type GenericAbout, type GenericCheck, type GenericClaim, type GenericResult } from "./types";

const CHECKS: GenericCheck[] = [g01];
CHECKS.push(g02);
CHECKS.push(g03);
CHECKS.push(g04);
CHECKS.push(g05);
CHECKS.push(g06);
CHECKS.push(g07);
CHECKS.push(g08);
CHECKS.push(g09);

/**
 * 言い切り（確定）に上げた種類（指摘の messageKey）。config/generic-checks.json の certain に、1 行ずつ { messageKey, verifiedIn }（どの段の報告で確かめたか）を足す。
 * 一覧にない種類は、点検がどう判定しても条件つきで出る（design.md §12-3）。2026-11-21 に、表の行の標本で原文と合った 4 種類を利用者の判断で足した（sources/research/certain-sample.md）
 */
export const CERTAIN: ReadonlySet<string> = new Set((raw.certain as { messageKey: string; verifiedIn: string }[]).map((c) => c.messageKey));

/**
 * masters が null（masters.db がない）・点検の準備ができていない（checks_ready）・診療年月の世代の 1 枚がない点検は動かさず、notRun に理由つきで返す。
 * 「指摘なし」は、ran に入っている点検についてだけ言える。checks と certain は、テストが作り物の点検を入れるための引数
 */
export function evaluateGeneric(claim: GenericClaim, masters: MastersDb | null, about: GenericAbout, checks: GenericCheck[] = CHECKS, certain: ReadonlySet<string> = CERTAIN): GenericResult {
  const result: GenericResult = { findings: [], ran: [], notRun: [] };
  for (const { id, kind } of GENERIC_CHECKS) {
    const skip = (reason: GenericResult["notRun"][number]["reason"], detail = "") => result.notRun.push({ check: id, kind, reason, detail });
    const check = checks.find((c) => c.id === id);
    if (!check) skip("notBuilt");
    else if (masters === null) skip("noMasters");
    else {
      const ready = checkReady(masters, id);
      if (!ready?.ready) {
        skip("notReady", ready?.reason ?? "");
        continue;
      }
      const found = check.run(claim, masters, about);
      if (!Array.isArray(found)) {
        skip("noSnapshot", found.skip);
        continue;
      }
      result.ran.push({ check: id, kind });
      // 点検ごとに FINDING_LIMIT 件まで。超えた分は数だけ返す（配列の展開で足さない：展開は数十万件で RangeError になる。round-32 S-9）
      const more = Math.max(0, found.length - FINDING_LIMIT) + (found.more ?? 0);
      if (more > 0) (result.omitted ??= []).push({ check: id, kind, count: more });
      // 言い切りの一覧は、種類（messageKey）か、背反の特例の例外の組ごと（messageKey#組の id。design.md §13-4。C-110・X-103）で照らす
      for (const f of found.slice(0, FINDING_LIMIT)) result.findings.push({ ...f, certainty: f.certainty === "確定" && (certain.has(f.messageKey) || certain.has(`${f.messageKey}#${f.params.hp}`)) ? "確定" : "条件つき" });
      for (const hx of found.silenced ?? []) {
        const s = (result.silenced ??= []).find((x) => x.hx === hx);
        if (s) s.count++;
        else result.silenced.push({ hx, count: 1 });
      }
      for (const id of found.localSilenced ?? []) {
        const s = (result.localSilenced ??= []).find((x) => x.id === id);
        if (s) s.count++;
        else result.localSilenced.push({ id, count: 1 });
      }
      if ((found.localUsed ?? []).length > 0) result.localUsed = [...new Set([...(result.localUsed ?? []), ...found.localUsed!])].sort();
    }
  }
  // G08 と G09 の重複は、ここでは消さない：手書きのルールとの重なり（src/generic/overlap.ts）で G08 が消えることがあるので、その後で消す（round-32 O-16）
  return result;
}
