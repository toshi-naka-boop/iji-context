// 会議の議題の「きっかけ」の文（app/meeting/page.tsx）：内部のイベント名をそのまま出さない
import { describe, expect, it } from "vitest";
import { eventLabel } from "../../src/lifecycle/machine";
import type { TriggerKind } from "../../src/lifecycle/types";
import { eventText, TRIGGER_LABEL } from "../../src/messages";

const TRIGGERS: TriggerKind[] = ["revision", "reappointment", "idle", "official", "localRevision", "localReturn"];

describe("eventText", () => {
  it("どのトリガーのイベント名（history の形）も日本語の名前になり、内部の名前が残らない", () => {
    for (const t of TRIGGERS) {
      const s = eventText(eventLabel({ type: "TRIGGER", trigger: t }), t);
      expect(s).toBe(TRIGGER_LABEL[t]);
      expect(s).not.toMatch(/TRIGGER|[A-Za-z]/);
    }
  });
  it("根拠のトリガーが同じなら括弧を付けない（重ねない）", () => {
    expect(eventText("TRIGGER{localReturn}", "localReturn")).toBe("この組の返戻・査定");
    expect(eventText("TRIGGER{idle}", "idle")).toBe("長く使われていない");
    expect(eventText("TRIGGER{idle}")).toBe("長く使われていない");
  });
  it("要再検証・停止に入るほかのイベントも日本語にする", () => {
    for (const e of ["COUNTER_EXAMPLE", "RECHECK_FAIL", "IDLE_EXPIRED"]) expect(eventText(e)).not.toMatch(/[A-Za-z]/);
  });
  it("根拠のトリガーが別のときは括弧で添える。イベント名がないときはトリガーの名前だけ", () => {
    expect(eventText("COUNTER_EXAMPLE", "official")).toBe("外れの確認で「直す必要がある」と答えた（公的文書）");
    expect(eventText("", "revision")).toBe("改定");
  });
  it("表にない名前はそのまま出す（消さない）", () => {
    expect(eventText("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(eventText("TRIGGER{other}")).toBe("other");
  });
});
