// メンターとの会話の記録の置き場（spec FR-214）。Agent SDK の sessionStore の形で、クリニックの app.db（鍵があれば暗号化）の sdk_transcripts に置く。
// SDK は会話の記録を手元（CLAUDE_CONFIG_DIR。本番は tmpfs）に書いたあと、ここへ写す。続きの会話（resume）は、ここから読んだものを手元に戻してから始まる。
// 行は SDK が渡す JSON のまま持つ（中身は読まない・ログに出さない）
import type Database from "better-sqlite3";
import type { SessionKey, SessionStore, SessionStoreEntry } from "./outbound";

/** 会話の記録の置き場。delete は projectKey によらず、会話の id（UUID）で消す（SDK が作る projectKey の作り方に頼らない） */
export function sqliteSessionStore(sqlite: Database.Database): SessionStore {
  const sub = (key: { subpath?: string }) => key.subpath ?? "";
  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]) {
      const at = Date.now();
      const ins = sqlite.prepare("INSERT OR IGNORE INTO sdk_transcripts (project_key, session_id, subpath, uuid, entry, at) VALUES (?, ?, ?, ?, ?, ?)");
      sqlite.transaction(() => {
        for (const e of entries) ins.run(key.projectKey, key.sessionId, sub(key), typeof e.uuid === "string" ? e.uuid : null, JSON.stringify(e), at);
      })();
    },
    async load(key: SessionKey) {
      const rows = sqlite.prepare("SELECT entry FROM sdk_transcripts WHERE session_id = ? AND subpath = ? ORDER BY id").all(key.sessionId, sub(key)) as { entry: string }[];
      return rows.length === 0 ? null : rows.map((r) => JSON.parse(r.entry) as SessionStoreEntry);
    },
    async listSessions(projectKey: string) {
      return (sqlite.prepare("SELECT session_id AS sessionId, MAX(at) AS mtime FROM sdk_transcripts WHERE project_key = ? GROUP BY session_id").all(projectKey) as { sessionId: string; mtime: number }[]).map((r) => ({ sessionId: r.sessionId, mtime: Math.floor(r.mtime) }));
    },
    async delete(key: SessionKey) {
      if (key.subpath) sqlite.prepare("DELETE FROM sdk_transcripts WHERE session_id = ? AND subpath = ?").run(key.sessionId, key.subpath);
      else sqlite.prepare("DELETE FROM sdk_transcripts WHERE session_id = ?").run(key.sessionId);
    },
    async listSubkeys(key: { projectKey: string; sessionId: string }) {
      return (sqlite.prepare("SELECT DISTINCT subpath FROM sdk_transcripts WHERE session_id = ? AND subpath != '' ORDER BY subpath").all(key.sessionId) as { subpath: string }[]).map((r) => r.subpath);
    },
  };
}
