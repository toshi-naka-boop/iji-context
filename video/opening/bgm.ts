/**
 * Write a quiet ambient BGM as WAV.
 * オープニング用の静かなアンビエント BGM をその場で合成して WAV に書く。外部の音源は使わない（ライセンスの問題が出ない）。
 * 4 つの和音をゆっくり重ねて切り替え、和音の変わり目にだけピアノに似た減衰音を 2 つ鳴らす。
 */
import fs from 'node:fs';

const SR = 44100;
// 明るめの長調の和音（Hz）。C(add9) → G(add9) → Fmaj7 → C(add9)
const CHORDS = [
  [261.63, 392.0, 587.33, 659.25],
  [196.0, 293.66, 440.0, 493.88],
  [174.61, 261.63, 440.0, 659.25],
  [261.63, 392.0, 587.33, 659.25],
];

export function writeBgm(file: string, seconds: number): void {
  const n = Math.round(seconds * SR);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const seg = seconds / CHORDS.length;
  const overlap = 2.5;

  CHORDS.forEach((chord, ci) => {
    const start = Math.max(0, ci * seg - overlap / 2);
    const end = Math.min(seconds, (ci + 1) * seg + overlap / 2);
    for (let i = Math.floor(start * SR); i < Math.floor(end * SR); i++) {
      const t = i / SR;
      const e = Math.min(1, (t - start) / overlap, (end - t) / overlap);
      const env = e * e * (3 - 2 * e);
      chord.forEach((f, k) => {
        const swell = 1 + 0.15 * Math.sin(2 * Math.PI * 0.13 * t + k);
        const a = 0.1 * env * swell;
        left[i] += a * (Math.sin(2 * Math.PI * f * t + k) + 0.25 * Math.sin(4 * Math.PI * f * t));
        right[i] += a * (Math.sin(2 * Math.PI * f * 1.003 * t + k * 1.7) + 0.25 * Math.sin(4 * Math.PI * f * 1.003 * t));
      });
    }
    // 和音の音を順に鳴らす減衰音（ピアノの代わり）
    const t0 = ci * seg + 0.3;
    [chord[1], chord[2], chord[3], chord[2] * 2, chord[3]].forEach((f, k) => {
      const s0 = t0 + k * 0.6;
      for (let i = Math.floor(s0 * SR); i < Math.min(n, Math.floor((s0 + 5) * SR)); i++) {
        const dt = i / SR - s0;
        const env = Math.min(1, dt / 0.01) * Math.exp(-dt * 1.1);
        const v = 0.09 * env * (Math.sin(2 * Math.PI * f * dt) + 0.3 * Math.exp(-dt * 2) * Math.sin(4 * Math.PI * f * dt));
        left[i] += v * (k ? 0.7 : 1);
        right[i] += v * (k ? 1 : 0.7);
      }
    });
  });

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const gain = 0.5 / (peak || 1);

  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(left[i] * gain * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(right[i] * gain * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}
