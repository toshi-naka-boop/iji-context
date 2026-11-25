// 会話の記録の置き場（spec FR-214）：SDK の sessionStore の形。SDK は呼ばず、SDK が呼ぶのと同じ順で呼んで確かめる
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { APP_MIGRATIONS, migrate } from "../../src/db/migrate";
import { sqliteSessionStore } from "../../src/llm/session-store";

const fresh = () => {
  const db = new Database(":memory:");
  migrate(db, APP_MIGRATIONS);
  return sqliteSessionStore(db);
};
const SID = "11111111-2222-4333-8444-555555555555";

describe("会話の記録の置き場", () => {
  it("書いた順に読み戻す。uuid の同じ行は二度入れず、uuid のない行は毎回足す。書いていない会話は null", async () => {
    const s = fresh();
    const key = { projectKey: "p", sessionId: SID };
    expect(await s.load(key)).toBeNull();
    await s.append(key, [{ type: "user", uuid: "u1", message: { content: "a" } }, { type: "title", title: "t" }]);
    await s.append(key, [{ type: "user", uuid: "u1", message: { content: "a" } }, { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "b" }] } }]);
    await s.append(key, [{ type: "title", title: "t" }]);
    expect(await s.load(key)).toEqual([
      { type: "user", uuid: "u1", message: { content: "a" } },
      { type: "title", title: "t" },
      { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "b" }] } },
      { type: "title", title: "t" },
    ]);
  });

  it("サブエージェントの記録（subpath）は別に持ち、一覧に出す。消すと会話ごと（subpath を渡せばそれだけ）消える", async () => {
    const s = fresh();
    const main = { projectKey: "p", sessionId: SID };
    const sub = { ...main, subpath: "subagents/agent-1" };
    await s.append(main, [{ type: "user", uuid: "u1" }]);
    await s.append(sub, [{ type: "user", uuid: "u1" }]);
    await s.append({ projectKey: "q", sessionId: "99999999-2222-4333-8444-555555555555" }, [{ type: "user", uuid: "x" }]);
    expect(await s.listSubkeys!(main)).toEqual(["subagents/agent-1"]);
    expect((await s.listSessions!("p")).map((r) => r.sessionId)).toEqual([SID]);
    await s.delete!(sub);
    expect(await s.load(sub)).toBeNull();
    expect(await s.load(main)).toEqual([{ type: "user", uuid: "u1" }]);
    await s.append(sub, [{ type: "user", uuid: "u2" }]);
    // 消すときは projectKey によらず、会話の id で消す
    await s.delete!({ projectKey: "", sessionId: SID });
    expect([await s.load(main), await s.load(sub)]).toEqual([null, null]);
    expect((await s.listSessions!("q")).length).toBe(1);
  });
});
