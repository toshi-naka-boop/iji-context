// 初回の声の台詞（FR-27）：4 人とも 4 つの台詞があり、名前を入れるのは greeting だけ。UI に使わない言葉が入っていない
import { describe, expect, it } from "vitest";
import VOICE from "../../config/voice-lines.json";
import CHARS from "../../config/characters.json";

const lines = (VOICE as unknown as { lines: Record<string, Record<string, string>> }).lines;
const ids = ((CHARS as unknown as { characters?: { id: string }[] }).characters ?? (CHARS as unknown as { id: string }[])).map((c) => c.id);

describe("初回の声の台詞", () => {
  it("どのキャラにも intro・askName・greeting・greetingNoName があり、{name} は greeting だけ", () => {
    expect(ids.length).toBe(4);
    for (const id of ids) {
      const l = lines[id];
      expect(Object.keys(l).sort()).toEqual(["askName", "greeting", "greetingNoName", "intro"]);
      expect(l.greeting).toContain("{name}");
      for (const k of ["intro", "askName", "greetingNoName"]) expect(l[k]).not.toContain("{name}");
    }
  });
  it("台詞に「教育」「学習」「学ぶ」「教える」を使わない", () => {
    expect(JSON.stringify(lines)).not.toMatch(/教育|学習|学ぶ|教える/);
  });
});
