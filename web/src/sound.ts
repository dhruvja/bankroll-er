import { useEffect, useState } from 'react';

/** Table sounds, synthesized with Web Audio (no files): a clack per face while the die tumbles, a
 * thunk when it settles, a rising tick per space a token walks and a plonk where it lands. Muting
 * persists per browser. Browsers only start audio after a gesture, so the first tap unlocks it. */
const KEY = 'bankroll.sound';
let context: AudioContext | undefined, noise: AudioBuffer | undefined;
let muted = (() => { try { return localStorage.getItem(KEY) === 'off'; } catch { return false; } })();
const listeners = new Set<(muted: boolean) => void>();

const unlock = () => {
  if (muted || typeof AudioContext === 'undefined') return;
  context ??= new AudioContext();
  if (context.state === 'suspended') void context.resume();
};
addEventListener('pointerdown', unlock, { passive: true });
addEventListener('keydown', unlock, { passive: true });

/** The running context, or nothing while muted or before the first gesture (sounds are then skipped). */
function audio() {
  return !muted && context?.state === 'running' ? context : undefined;
}

function burst(ctx: AudioContext, at: number, frequency: number, q: number, peak: number, length: number) {
  noise ??= (() => {
    const buffer = ctx.createBuffer(1, ctx.sampleRate / 4, ctx.sampleRate), data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  })();
  const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
  source.buffer = noise;
  filter.type = 'bandpass'; filter.frequency.value = frequency; filter.Q.value = q;
  gain.gain.setValueAtTime(peak, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + length);
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(at, Math.random() * 0.2, length);
}

function tone(ctx: AudioContext, at: number, type: OscillatorType, from: number, to: number, peak: number, length: number) {
  const oscillator = ctx.createOscillator(), gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(from, at);
  oscillator.frequency.exponentialRampToValueAtTime(to, at + length);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + length + 0.02);
}

export const sounds = {
  /** One face of the tumbling die hitting the table. */
  clack() {
    const ctx = audio();
    if (ctx) burst(ctx, ctx.currentTime, 1800 + Math.random() * 1600, 4, 0.35, 0.045);
  },
  /** The die coming to rest. */
  settle() {
    const ctx = audio();
    if (!ctx) return;
    burst(ctx, ctx.currentTime, 900, 2, 0.5, 0.09);
    tone(ctx, ctx.currentTime, 'sine', 190, 120, 0.25, 0.12);
  },
  /** A token stepping one space; `left` is how many spaces remain, so the walk rises to its end. */
  step(left: number) {
    const ctx = audio();
    if (ctx) tone(ctx, ctx.currentTime, 'triangle', 760 - Math.min(left, 9) * 38, 700 - Math.min(left, 9) * 38, 0.12, 0.06);
  },
  /** Your turn: a short rising two-note chime. */
  turn() {
    const ctx = audio();
    if (!ctx) return;
    tone(ctx, ctx.currentTime, 'triangle', 523, 523, 0.14, 0.14);
    tone(ctx, ctx.currentTime + 0.11, 'triangle', 784, 784, 0.14, 0.22);
  },
  /** A token arriving on its space. */
  land() {
    const ctx = audio();
    if (!ctx) return;
    tone(ctx, ctx.currentTime, 'sine', 660, 640, 0.16, 0.16);
    tone(ctx, ctx.currentTime + 0.07, 'sine', 880, 860, 0.12, 0.2);
  },
};

/** The mute switch: `[muted, toggle]`, shared by every mounted toggle. */
export function useSoundToggle(): [boolean, () => void] {
  const [value, setValue] = useState(muted);
  useEffect(() => { listeners.add(setValue); return () => { listeners.delete(setValue); }; }, []);
  const toggle = () => {
    muted = !muted;
    try { localStorage.setItem(KEY, muted ? 'off' : 'on'); } catch { /* Preference only. */ }
    if (!muted) unlock();
    for (const listener of listeners) listener(muted);
  };
  return [value, toggle];
}
