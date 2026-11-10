import { useEffect, useState } from 'react';

/** Table sounds, synthesized with Web Audio (no files): a clack per face while the die tumbles, a
 * thunk when it settles, a rising tick per space a token walks and a plonk where it lands, plus one
 * for each kind of announcement (purchase, money in and out, jail, building, swaps, bankruptcy) and
 * the end of the game. Muting
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

/** A struck bell: a sine that rings out with a faint overtone. */
function bell(ctx: AudioContext, at: number, frequency: number, peak: number, length: number) {
  tone(ctx, at, 'sine', frequency, frequency, peak, length);
  tone(ctx, at, 'sine', frequency * 2.76, frequency * 2.76, peak / 4, length / 2);
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
  /** A purchase: the register drawer, then a two-bell "ka-ching". */
  buy() {
    const ctx = audio();
    if (!ctx) return;
    const at = ctx.currentTime;
    burst(ctx, at, 2400, 3, 0.3, 0.06);
    burst(ctx, at + 0.05, 1500, 4, 0.2, 0.05);
    bell(ctx, at + 0.1, 1319, 0.16, 0.7);
    bell(ctx, at + 0.18, 1760, 0.14, 0.9);
  },
  /** Money coming in: a quick rising sparkle. */
  coinIn() {
    const ctx = audio();
    if (!ctx) return;
    [1047, 1319, 1568, 2093].forEach((frequency, i) => bell(ctx, ctx.currentTime + i * 0.055, frequency, 0.11, 0.28));
  },
  /** Money going out: two soft falling notes. */
  coinOut() {
    const ctx = audio();
    if (!ctx) return;
    tone(ctx, ctx.currentTime, 'triangle', 660, 600, 0.13, 0.16);
    tone(ctx, ctx.currentTime + 0.12, 'triangle', 494, 440, 0.13, 0.26);
  },
  /** Going to jail: a heavy metal door. Inharmonic partials ring over a thud. */
  jail() {
    const ctx = audio();
    if (!ctx) return;
    const at = ctx.currentTime;
    burst(ctx, at, 700, 1.5, 0.4, 0.12);
    tone(ctx, at, 'sine', 110, 70, 0.3, 0.3);
    [523, 1137, 1789, 2456].forEach((frequency, i) => bell(ctx, at, frequency, 0.09 / (i + 1), 0.8));
  },
  /** A player going bankrupt: three sinking notes, the last one long. */
  bankrupt() {
    const ctx = audio();
    if (!ctx) return;
    const at = ctx.currentTime;
    tone(ctx, at, 'triangle', 392, 370, 0.15, 0.3);
    tone(ctx, at + 0.3, 'triangle', 349, 330, 0.15, 0.3);
    tone(ctx, at + 0.6, 'triangle', 311, 233, 0.16, 0.9);
  },
  /** Building a house or hotel: two hammer taps. */
  build() {
    const ctx = audio();
    if (!ctx) return;
    for (const delay of [0, 0.14]) {
      burst(ctx, ctx.currentTime + delay, 1300, 2, 0.35, 0.05);
      tone(ctx, ctx.currentTime + delay, 'sine', 150, 90, 0.22, 0.09);
    }
  },
  /** A completed swap: two bells together. */
  trade() {
    const ctx = audio();
    if (!ctx) return;
    bell(ctx, ctx.currentTime, 880, 0.12, 0.6);
    bell(ctx, ctx.currentTime + 0.09, 1319, 0.12, 0.7);
  },
  /** A missed deadline: a short low buzz. */
  strike() {
    const ctx = audio();
    if (ctx) tone(ctx, ctx.currentTime, 'square', 147, 139, 0.06, 0.25);
  },
  /** You won: a rising arpeggio that lands on a held chord. */
  fanfare() {
    const ctx = audio();
    if (!ctx) return;
    const at = ctx.currentTime;
    [523, 659, 784].forEach((frequency, i) => tone(ctx, at + i * 0.12, 'triangle', frequency, frequency, 0.15, 0.2));
    [523, 659, 784, 1047].forEach(frequency => tone(ctx, at + 0.38, 'triangle', frequency, frequency, 0.09, 1.1));
  },
  /** The game ended and someone else won: a gentle closing pair. */
  gameOver() {
    const ctx = audio();
    if (!ctx) return;
    tone(ctx, ctx.currentTime, 'triangle', 523, 523, 0.12, 0.3);
    tone(ctx, ctx.currentTime + 0.22, 'triangle', 392, 392, 0.12, 0.6);
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
