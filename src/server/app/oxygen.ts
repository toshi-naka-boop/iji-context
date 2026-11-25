// 届け出た酸素の単価（design.md §19-3・§19-8。v44 段 22e）：施設の申告の画面の「酸素の単価（任意）」。追記だけで、取り消しは取り消しの行で表す。
// 施設の値で、採用値ではない。AI に送る文脈と UKE の書き出しには入れない。監査ログには、入れた・取り消したことと区分だけを残す（route の audit）
import { activeOxygenPrices, centiOf, fiscalYearOf, OXYGEN_CODE, OXYGEN_KINDS, oxygenPriceOn, type OxygenBasis, type OxygenKind, type OxygenPriceRow } from "../../facility/oxygen";
import { pickSnapshot, tokuteiOf, withMasters } from "../../masters/db";
import { badRequest } from "../errors";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import { todayOf } from "./facility";

export type OxygenPriceInput = { kind: OxygenKind; price: string; validFrom: string; validUntil: string; basis: OxygenBasis } | { revokes: number };

/** 表の全部の行（取り消しの行を含む。古い順） */
export function readOxygenPrices(ctx: Pick<AppContext, "sqlite">): OxygenPriceRow[] {
  const rows = ctx.sqlite.prepare("SELECT * FROM oxygen_prices ORDER BY id").all() as Record<string, string | number | null>[];
  return rows.map((r) => ({ id: r.id as number, kind: r.kind as OxygenKind, priceCenti: r.price_centi as number, validFrom: r.valid_from as string, validUntil: r.valid_until as string, basis: r.basis as OxygenBasis, enteredBy: r.entered_by as string, enteredAt: r.entered_at as string, revokes: (r.revokes as number | null) ?? null }));
}

/** 上限（マスターの離島等でないコードの金額。R8-317）を 0.01 円の整数で。マスターがなければ null */
function limitsOf(today: string): Record<OxygenKind, number | null> {
  const ym = today.slice(0, 7);
  return withMasters((db) => {
    const out = { CE: null, LGC: null, large: null, small: null } as Record<OxygenKind, number | null>;
    const snap = db ? (pickSnapshot(db, "tokutei", ym, "R8") ?? null) : null;
    if (!db || !snap) return out;
    for (const k of OXYGEN_KINDS) {
      const row = tokuteiOf(db, snap.snapshot, OXYGEN_CODE[k]);
      out[k] = row ? Math.round(row.price * 100) : null;
    }
    return out;
  });
}

export function createOxygenPrices(ctx: Pick<AppContext, "sqlite">, clock: Pick<Clock, "now">, clerks: Pick<Clerks, "clerk">) {
  /** 画面に出す形：区分ごとに今日に効く単価・上限と、取り消されていない行。入力の初期値（今日の年度） */
  function oxygenPrices() {
    const today = todayOf(clock);
    const all = readOxygenPrices(ctx);
    const active = activeOxygenPrices(all);
    const limits = limitsOf(today);
    return {
      today,
      defaults: fiscalYearOf(today),
      kinds: OXYGEN_KINDS.map((kind) => ({ kind, todayCenti: oxygenPriceOn(active, kind, today), limitCenti: limits[kind] })),
      rows: active,
    };
  }

  function saveOxygenPrice(clerkId: string, input: OxygenPriceInput) {
    clerks.clerk(clerkId);
    const now = clock.now();
    if ("revokes" in input) {
      const target = readOxygenPrices(ctx).find((r) => r.id === input.revokes);
      if (!target || target.revokes !== null) throw badRequest("取り消す行がありません", ["revokes"]);
      if (!activeOxygenPrices(readOxygenPrices(ctx)).some((r) => r.id === target.id)) throw badRequest("その行はもう取り消してあります", ["revokes"]);
      ctx.sqlite
        .prepare("INSERT INTO oxygen_prices (kind, price_centi, valid_from, valid_until, basis, entered_by, entered_at, revokes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(target.kind, target.priceCenti, target.validFrom, target.validUntil, target.basis, clerkId, now, target.id);
      return oxygenPrices();
    }
    const centi = centiOf(input.price);
    if (centi === null) throw badRequest("単価は 0 より大きく、小数第 2 位までで入れてください", ["price"]);
    if (input.validFrom > input.validUntil) throw badRequest("適用の始めは、終わりと同じ日か前にしてください", ["validUntil"]);
    ctx.sqlite
      .prepare("INSERT INTO oxygen_prices (kind, price_centi, valid_from, valid_until, basis, entered_by, entered_at, revokes) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(input.kind, centi, input.validFrom, input.validUntil, input.basis, clerkId, now);
    return oxygenPrices();
  }

  /** 監査ログの区分：取り消しの行（取り消した行の値の写し）を含む全部の行から、その id の行の区分を引く（取り消したあとでも引ける。反証 round-94 X-473・C-620） */
  const oxygenPriceKindOf = (id: number): OxygenKind | null => readOxygenPrices(ctx).find((r) => r.id === id)?.kind ?? null;

  return { oxygenPrices, saveOxygenPrice, oxygenPriceKindOf };
}
