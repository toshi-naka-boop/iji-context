"use client";
// 初回にキャラを選んだときのあいさつ（spec FR-27）：自己紹介 → 呼び方を聞く → 本人が声か文字で答え、確かめて決定 → 名前を入れてあいさつ。
// 声は ElevenLabs（/api/voice/*）。声が出せないとき（キーがない・通信の失敗・マイクが使えない）も、文字だけで最後まで進める。
// ブラウザは操作の直後でないと音を出さないので、キャラを押したクリックの中で unlockAudio() を呼んでおく
import { useEffect, useRef, useState } from "react";
import type { Character } from "../src/mentor/prompt";
import { selectImage } from "../src/mentor/face";
import VOICE from "../config/voice-lines.json";

type Line = "intro" | "askName" | "greeting" | "greetingNoName";
const textOf = (characterId: string, line: Line, name = "") =>
  ((VOICE as unknown as { lines: Record<string, Record<Line, string>> }).lines[characterId]?.[line] ?? "").replace("{name}", name);

let audioCtx: AudioContext | null = null;
/** クリックの中で呼ぶ。以後このページでは声を流せる */
export function unlockAudio() {
  try {
    audioCtx ??= new AudioContext();
    void audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

/** 台詞を読み上げて、終わるまで待つ。流せなければ false（呼ぶ側は文字だけで進める） */
async function playLine(characterId: string, line: Line, name?: string): Promise<boolean> {
  if (!audioCtx) return false;
  try {
    const r = await fetch("/api/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ characterId, line, name }) });
    if (!r.ok) return false;
    const buf = await audioCtx.decodeAudioData(await r.arrayBuffer());
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    await new Promise<void>((done) => {
      src.onended = () => done();
      src.start();
    });
    return true;
  } catch {
    return false;
  }
}

type Phase = "intro" | "ask" | "greeting" | "done";

export function Welcome({ character, autoStart, onDone }: { character: Character; autoStart: boolean; onDone: (name: string) => void }) {
  const id = character.id;
  const [phase, setPhase] = useState<Phase>(autoStart ? "intro" : "ask");
  const [line, setLine] = useState(textOf(id, autoStart ? "intro" : "askName"));
  const [name, setName] = useState("");
  const [saved, setSaved] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const silent = useRef(false);

  /** 声が出せなかったら一度だけ知らせる */
  const said = (ok: boolean) => {
    if (!ok && !silent.current) {
      silent.current = true;
      setNote("声を出せませんでした。文字で進めます。");
    }
  };
  async function introAndAsk() {
    setPhase("intro");
    setLine(textOf(id, "intro"));
    said(await playLine(id, "intro"));
    setLine(textOf(id, "askName"));
    setPhase("ask");
    if (!silent.current) said(await playLine(id, "askName"));
  }
  const started = useRef(false);
  useEffect(() => {
    // 開発時の 2 回実行でも、声は 1 回だけ流す
    if (autoStart && !started.current) {
      started.current = true;
      void introAndAsk();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleMic() {
    setErr("");
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setBusy(true);
        try {
          const form = new FormData();
          form.append("audio", new Blob(chunks, { type: rec.mimeType }), "name.webm");
          const r = await fetch("/api/voice/listen", { method: "POST", body: form });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error ?? "聞き取れませんでした");
          // 聞き取った文字は入力欄に入れるだけ。決めるのは本人
          setName(String(d.text ?? ""));
        } catch (e) {
          setErr(`聞き取れませんでした。文字で入れてください（${(e as Error).message}）`);
        } finally {
          setBusy(false);
        }
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setErr("マイクを使えませんでした。文字で入れてください。");
    }
  }

  async function decide() {
    setErr("");
    unlockAudio();
    setBusy(true);
    try {
      const r = await fetch("/api/clerk/name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "保存できませんでした");
      setSaved(d.name);
      setPhase("greeting");
      setLine(textOf(id, "greeting", d.name));
      // あいさつ（名前入り）が流せなければ、名前なしの定型を声で流す。画面の文字は名前入りのまま。声がどちらも駄目なら文字だけ
      if (!(await playLine(id, "greeting", d.name))) said(await playLine(id, "greetingNoName"));
      setPhase("done");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {character.image && <img src={selectImage(character.image)} alt="" style={{ width: 180 }} />}
        <div style={{ flex: 1, minWidth: 240 }}>
          <strong>{character.name}</strong>
          <div className="bubble" style={{ marginTop: 8 }}>{line}</div>
          {note && <div className="muted" style={{ marginTop: 6 }}>{note}</div>}
          {phase === "ask" && (
            <div style={{ marginTop: 12 }}>
              <label>
                呼び方：
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} disabled={busy} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && name.trim() && !busy) void decide(); }} />
              </label>{" "}
              <button onClick={toggleMic} disabled={busy && !recording} aria-pressed={recording}>{recording ? "録音を止める" : "声で答える"}</button>{" "}
              <button className="primary" onClick={decide} disabled={busy || recording || !name.trim()}>決定</button>
              <div className="muted">声で答えると、聞き取った文字が入力欄に入ります。確かめて直してから「決定」を押してください。</div>
              {!autoStart && <p><button onClick={() => { unlockAudio(); void introAndAsk(); }} disabled={busy}>もう一度聞く</button></p>}
            </div>
          )}
          {err && <div className="notice warn">{err}</div>}
          {phase === "done" && <p><button className="primary" onClick={() => onDone(saved)}>はじめる</button></p>}
        </div>
      </div>
    </div>
  );
}
