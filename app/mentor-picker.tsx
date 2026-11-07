"use client";
// メンターのキャラと話し方を選ぶ（FR-19・FR-20）。はじめての算定画面と、設定の画面の両方で使う
import type { Character } from "../src/mentor/prompt";
import { PREFERENCES, TYPES16, type Style } from "../src/mentor/style";
import { selectImage } from "../src/mentor/face";

export type MentorChoice = { chosen: boolean; current: Character; characters: Character[]; style: Style };

async function post(body: unknown): Promise<MentorChoice> {
  const r = await fetch("/api/character", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "エラー");
  return d as MentorChoice;
}

/** キャラを押すと選んだことになる。話し方の好み・16 タイプは任意で、変えるとすぐ保存する */
export function MentorPicker({ choice, clerkId, onChange, onError }: { choice: MentorChoice; clerkId: string; onChange: (c: MentorChoice) => void; onError: (msg: string) => void }) {
  const run = (body: unknown) => post({ clerkId, ...(body as object) }).then(onChange).catch((e: Error) => onError(e.message));
  const pickStyle = (style: Style) => run({ style });
  return (
    <>
      <p className="muted">
        話し方の好み（任意）：
        <select value={choice.style?.preference ?? ""} onChange={(e) => pickStyle({ ...choice.style, preference: (e.target.value || undefined) as Style["preference"] })}>
          <option value="">指定しない</option>
          {PREFERENCES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        　16 タイプ（任意・自己申告）：
        <select value={choice.style?.type16 ?? ""} onChange={(e) => pickStyle({ ...choice.style, type16: (e.target.value || undefined) as Style["type16"] })}>
          <option value="">指定しない</option>
          {TYPES16.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </p>
      <div className="chooser">
        {choice.characters.map((c) => (
          <button key={c.id} className={`chooser-card${choice.chosen && c.id === choice.current.id ? " current" : ""}`} onClick={() => run({ characterId: c.id })}>
            {c.image && <img src={selectImage(c.image)} alt="" />}
            <strong>{c.name}</strong>
            <span className="muted">{c.tone}</span>
            {c.examples?.opening && <span className="bubble">{c.examples.opening}</span>}
          </button>
        ))}
      </div>
    </>
  );
}
