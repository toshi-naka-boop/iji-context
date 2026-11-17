// 医療事務
import { validateStyle, type Style } from "../../mentor/style";
import type { AppContext } from "./context";
import { badRequest, notFound } from "../errors";

/** 本人が決めた名前を検査する（1〜20 文字。改行・制御文字と、指示の書式に使われる記号は受け付けない） */
export function cleanName(raw: string): string {
  const n = raw.trim();
  if (n.length < 1 || n.length > 20) throw badRequest("名前は 1〜20 文字で入れてください");
  if (/[\u0000-\u001f\u007f#`<>{}[\]|\\*_]/.test(n)) throw badRequest("名前に使えない文字があります");
  return n;
}

export function createClerks(ctx: AppContext) {
  const { sqlite, setting, setSetting } = ctx;

  function upsertClerk(c: { id: string; name: string; callName: string; characterId: string; role: "clerk" | "veteran" }) {
    sqlite
      .prepare("INSERT INTO clerks (id, name, call_name, character_id, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, call_name = excluded.call_name, role = excluded.role")
      .run(c.id, c.name, c.callName, c.characterId, c.role);
  }
  /** 審査員などが自分の利用者を作る（名前は呼び方に使う）。キャラは選ぶまで仮の a */
  function createClerk(name: string) {
    const n = name.trim();
    if (n.length < 1 || n.length > 20) throw badRequest("名前は 1〜20 文字");
    // 番号は、いまある番号の最大の次（件数から振ると、行が消えたときに既存の id とぶつかる）。採番と保存は 1 つのトランザクションで、既存の行は上書きしない
    const id = sqlite
      .transaction(() => {
        const max = (sqlite.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) AS n FROM clerks WHERE id GLOB 'u[0-9]*'").get() as { n: number }).n;
        const next = `u${String(max + 1).padStart(4, "0")}`;
        sqlite.prepare("INSERT INTO clerks (id, name, call_name, character_id, role) VALUES (?, ?, 'さん', 'a', 'clerk')").run(next, n);
        return next;
      })
      .immediate();
    return clerk(id);
  }
  function clerk(id: string) {
    const r = sqlite.prepare("SELECT * FROM clerks WHERE id = ?").get(id) as { id: string; name: string; call_name: string; character_id: string; role: string; session_id: string | null } | undefined;
    if (!r) throw notFound(`医療事務が登録されていない: ${id}`);
    return r;
  }
  const setSession = (id: string, sessionId: string) => sqlite.prepare("UPDATE clerks SET session_id = ? WHERE id = ?").run(sessionId, id);
  /** 本人がメンターを選ぶ（FR-19）。指示はセッションの初めに渡すので、キャラを変えたらセッションを作り直す */
  function chooseCharacter(id: string, characterId: string) {
    clerk(id);
    sqlite.prepare("UPDATE clerks SET character_id = ?, session_id = NULL WHERE id = ?").run(characterId, id);
    setSetting(`character_chosen:${id}`, "1");
  }
  const characterChosen = (id: string) => setting(`character_chosen:${id}`) === "1";
  /**
   * 初回のあいさつ（FR-27）で本人が決めた名前を保存する。名前は CLAUDE.md の呼び方に入るので、
   * 決まった規則で文字を絞る。呼び方は会話のはじめに作るので、会話を切って次から新しい名前で呼ぶ
   */
  function setClerkName(id: string, name: string) {
    clerk(id);
    const n = cleanName(name);
    sqlite.prepare("UPDATE clerks SET name = ?, session_id = NULL WHERE id = ?").run(n, id);
    setSetting(`welcomed:${id}`, "1");
    return clerk(id);
  }
  /** 初回のあいさつ（名前を決めるまで）が済んだか */
  const welcomed = (id: string) => setting(`welcomed:${id}`) === "1";
  /** 伝え方のタイプ（FR-20。本人の申告、任意）。指示はセッションの初めに渡すので、変えたらセッションを作り直す */
  function setStyle(id: string, style: Style) {
    clerk(id);
    setSetting(`style:${id}`, JSON.stringify(validateStyle(style)));
    sqlite.prepare("UPDATE clerks SET session_id = NULL WHERE id = ?").run(id);
  }
  const styleOf = (id: string): Style => JSON.parse(setting(`style:${id}`) ?? "{}") as Style;

  return { upsertClerk, createClerk, clerk, setSession, chooseCharacter, characterChosen, setClerkName, welcomed, setStyle, styleOf };
}

export type Clerks = ReturnType<typeof createClerks>;
