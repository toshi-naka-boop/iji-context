import { describe, expect, it } from "vitest";
import { transition } from "../../src/lifecycle/machine";
import { verificationQueue } from "../../src/lifecycle/queue";
import { makeMeta } from "./helpers";

const cand = (id: string, empathy: number, at: string, status: "未検証" | "承認済み" = "未検証") =>
  makeMeta({ id, status, empathy, source_event: { type: "返戻", ref: id, at } });

describe("検証キュー", () => {
  it("empathy 降順、同数なら source_event.at 昇順", () => {
    const q = verificationQueue([
      cand("regional/a", 1, "2025-01-01T00:00:00+09:00"),
      cand("regional/b", 3, "2025-02-01T00:00:00+09:00"),
      cand("regional/c", 3, "2025-01-15T00:00:00+09:00"),
      cand("regional/d", 0, "2024-12-01T00:00:00+09:00"),
    ]);
    expect(q.map((m) => m.id)).toEqual(["regional/c", "regional/b", "regional/a", "regional/d"]);
  });
  it("未検証だけが並ぶ", () => {
    const q = verificationQueue([cand("regional/a", 9, "2025-01-01T00:00:00+09:00", "承認済み"), cand("regional/b", 0, "2025-01-01T00:00:00+09:00")]);
    expect(q.map((m) => m.id)).toEqual(["regional/b"]);
  });
  it("同数・同時刻は id 昇順で安定する", () => {
    const q = verificationQueue([cand("regional/z", 1, "2025-01-01T00:00:00+09:00"), cand("regional/y", 1, "2025-01-01T00:00:00+09:00")]);
    expect(q.map((m) => m.id)).toEqual(["regional/y", "regional/z"]);
  });
  it("入力配列を並べ替えない", () => {
    const input = [cand("regional/a", 0, "2025-01-01T00:00:00+09:00"), cand("regional/b", 5, "2025-01-01T00:00:00+09:00")];
    verificationQueue(input);
    expect(input.map((m) => m.id)).toEqual(["regional/a", "regional/b"]);
  });
  it("EMPATHY で並び順だけが変わり、状態は変わらない", () => {
    const a = cand("regional/a", 0, "2025-01-01T00:00:00+09:00");
    const b = cand("regional/b", 0, "2025-02-01T00:00:00+09:00");
    expect(verificationQueue([a, b]).map((m) => m.id)).toEqual(["regional/a", "regional/b"]);
    const r = transition(b, { type: "EMPATHY" }, "2025-03-01T00:00:00+09:00");
    expect(r.meta.status).toBe("未検証");
    expect(r.meta.status_since).toBe(b.status_since);
    expect(verificationQueue([a, r.meta]).map((m) => m.id)).toEqual(["regional/b", "regional/a"]);
    expect(verificationQueue([a, r.meta]).every((m) => m.status === "未検証")).toBe(true);
  });
});
