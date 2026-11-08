// R04 在宅療養指導管理料は主たる 1 つのみ。材料加算は各々算定可
import type { Rule } from "../types";
import { finding, present } from "./util";

const KANRI = ["C101_2I", "C103_2"];

export const r04: Rule = {
  id: "R04",
  kubun: KANRI,
  reference: "第2部第2節第1款 通則2（主たる指導管理の所定点数のみ）",
  appliesTo: (ctx) => present(ctx, KANRI).length > 0,
  needs: () => [],
  check(ctx) {
    const p = present(ctx, KANRI);
    return p.length >= 2 ? [finding(this, "背反", p, "only_main")] : [];
  },
};
