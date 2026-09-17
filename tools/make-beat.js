#!/usr/bin/env node
'use strict';

/**
 * Synthesises the stand-in track the Dance tab plays: frontend/audio/dakait-beat.mp3
 *
 * The routines in config/dances.json were choreographed to FA9LA (Flipperachi)
 * — the Rehman Dakait entry from Dhurandhar. That recording is Saregama's and
 * is not in this repo. This is an original instrumental in the same shape so
 * the feature works out of the box: 102 BPM, 4/4, D hijaz (the "Arabic" scale
 * the track lives on), trap kick and 808, and sections laid out to land under
 * the routines the way the real song's do:
 *
 *   bars  0– 3   0.0– 9.4 s   intro     drone, riser, one hit at bar 2 for the reveal
 *   bars  4– 8   9.4–21.2 s   groove    half-time swagger, sparse lead
 *   bars  9–15  21.2–37.6 s   hook      the riff, kick on every beat — the crown lands here
 *   bars 16–20  37.6–49.4 s   drop      heavier, lead an octave up
 *   bars 21–27  49.4–65.9 s   groove    variation
 *   bars 28–    65.9–70.0 s   outro     fade
 *
 * No dependencies: samples are rendered straight into a Float64Array and
 * written as 16-bit WAV; ffmpeg, if present, turns that into the MP3 the page
 * loads. Without ffmpeg the WAV is used directly — larger, plays the same.
 *
 * Swap in the real song whenever you have it: 📂 Track on the Dance tab, or
 * point _audio.file in dances.json somewhere else. This file is only the
 * default.
 *
 * Usage:  npm run beat            (from backend/)
 *         node tools/make-beat.js (from the project root)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SR = 44100;
const BPM = 102;
const BEAT = 60 / BPM;          // 0.588 s
const BAR = BEAT * 4;           // 2.353 s
const LENGTH_S = 70;

const OUT_DIR = path.resolve(__dirname, '..', 'frontend', 'audio');
const WAV = path.join(OUT_DIR, 'dakait-beat.wav');
const MP3 = path.join(OUT_DIR, 'dakait-beat.mp3');

const buf = new Float64Array(Math.ceil(LENGTH_S * SR));

// ------------------------------------------------------------- utilities --

const TAU = Math.PI * 2;

/* Deterministic noise, so two runs of this script produce the same file and
   a regenerated beat does not silently shift the clip offsets in dances.json. */
let seed = 0x9e3779b9;
function rand() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) / 4294967296) * 2 - 1;
}

/** Render `fn(t)` for `dur` seconds starting at `at`, scaled by gain, into buf. */
function play(at, dur, gain, fn) {
  const start = Math.floor(at * SR);
  const n = Math.min(Math.floor(dur * SR), buf.length - start);
  for (let i = 0; i < n; i++) buf[start + i] += fn(i / SR) * gain;
}

const decay = (t, tau) => Math.exp(-t / tau);
const soft = (x) => Math.tanh(x);

// note frequencies — D hijaz: D Eb F# G A Bb C
const NOTE = {
  D1: 36.71, Eb1: 38.89, F1: 43.65, G1: 49.00,
  D4: 293.66, Eb4: 311.13, Fs4: 369.99, G4: 392.00, A4: 440.00, Bb4: 466.16, C5: 523.25,
  D5: 587.33, Eb5: 622.25, Fs5: 739.99, G5: 783.99, A5: 880.00, Bb5: 932.33, C6: 1046.50, D6: 1174.66,
};

// ----------------------------------------------------------- instruments --

/* Kick: a sine whose pitch falls fast from a click down to the fundamental,
   with a little drive so it holds up on a phone speaker. */
function kick(at, gain = 1) {
  play(at, 0.4, gain, (t) => {
    const f = 45 + 140 * Math.exp(-t / 0.045);
    return soft(2.2 * Math.sin(TAU * f * t) * decay(t, 0.16));
  });
}

/* Snare: tone plus a burst of noise, the noise carrying most of it. */
function snare(at, gain = 1) {
  play(at, 0.25, gain, (t) =>
    0.35 * Math.sin(TAU * 185 * t) * decay(t, 0.06) +
    0.9 * rand() * decay(t, 0.09));
}

/* Hat: short noise, crudely high-passed by differencing. */
function hat(at, gain = 1, open = false) {
  let prev = 0;
  play(at, open ? 0.22 : 0.06, gain, (t) => {
    const x = rand();
    const hp = x - prev;
    prev = x;
    return hp * 0.6 * decay(t, open ? 0.09 : 0.018);
  });
}

/* 808: a sine on the note with a pitch drop on the attack and saturation, the
   way a trap bass is made rather than the way a bass guitar is. */
function bass(at, note, dur = 0.55, gain = 1) {
  const f0 = NOTE[note];
  play(at, dur, gain, (t) => {
    const f = f0 * (1 + 0.9 * Math.exp(-t / 0.02));
    const env = Math.min(1, t / 0.008) * decay(t, dur * 0.55);
    return soft(1.8 * Math.sin(TAU * f * t)) * env;
  });
}

/* Lead: a plucked tone — three harmonics, the upper ones dying first, and a
   hint of vibrato so it reads as played rather than typed. */
function lead(at, note, dur = 0.28, gain = 1) {
  const f0 = NOTE[note];
  play(at, dur + 0.15, gain, (t) => {
    const vib = 1 + 0.004 * Math.sin(TAU * 5.5 * t);
    const f = f0 * vib;
    const env = Math.min(1, t / 0.004) * (t < dur ? decay(t, 0.4) : decay(t, 0.4) * decay(t - dur, 0.03));
    return (Math.sin(TAU * f * t) +
            0.45 * Math.sin(TAU * 2 * f * t) * decay(t, 0.12) +
            0.2 * Math.sin(TAU * 3 * f * t) * decay(t, 0.06)) * env * 0.5;
  });
}

/* Crash: long noise, mellowed by averaging. */
function crash(at, gain = 1) {
  let a = 0;
  play(at, 1.6, gain, (t) => {
    a = a * 0.6 + rand() * 0.4;
    return a * 0.7 * decay(t, 0.45);
  });
}

/* Riser: noise and a climbing tone swelling into a downbeat. */
function riser(at, dur, gain = 1) {
  play(at, dur, gain, (t) => {
    const p = t / dur;
    const f = 80 + 900 * p * p;
    return (0.5 * rand() + 0.5 * Math.sin(TAU * f * t)) * p * p * 0.6;
  });
}

/* Drone: two low sines a fifth apart, held under the intro. */
function drone(at, dur, gain = 1) {
  play(at, dur, gain, (t) => {
    const env = Math.min(1, t / 1.2) * Math.min(1, (dur - t) / 1.2);
    return (Math.sin(TAU * NOTE.D1 * t) + 0.35 * Math.sin(TAU * NOTE.D1 * 1.5 * t) +
            0.15 * Math.sin(TAU * NOTE.D1 * 2 * t)) * env * 0.5;
  });
}

// ---------------------------------------------------------------- patterns --

const at = (bar, beat) => bar * BAR + beat * BEAT;

// the riff — descending hijaz, the shape the real song's hook has
const RIFF_A = ['D5', 'C5', 'Bb4', 'A4', 'Bb4', 'A4', 'G4', 'Fs4'];
const RIFF_B = ['G4', 'A4', 'Bb4', 'A4', 'G4', 'Fs4', 'Eb4', 'D4'];
const UP = { D4: 'D5', Eb4: 'Eb5', Fs4: 'Fs5', G4: 'G5', A4: 'A5', Bb4: 'Bb5', C5: 'C6', D5: 'D6' };

function hats(bar, { roll = false, gain = 0.5 } = {}) {
  for (let e = 0; e < 8; e++) hat(at(bar, e / 2), e % 2 ? gain * 0.6 : gain);
  if (roll) for (let s = 12; s < 16; s++) hat(at(bar, s / 4), gain * 0.7);
  hat(at(bar, 3.5), gain * 0.8, true);
}

function grooveBar(bar, { lead: withLead = false, variation = 0 } = {}) {
  // half-time swagger: kick 1 and the "and" of 2, snare on 3
  kick(at(bar, 0));
  kick(at(bar, 1.5), 0.85);
  kick(at(bar, 2.75), 0.7);
  snare(at(bar, 2), 0.9);
  hats(bar, { roll: bar % 4 === 3 });

  bass(at(bar, 0), 'D1', 0.9);
  bass(at(bar, 1.5), 'D1', 0.5, 0.8);
  bass(at(bar, 2.75), variation ? 'Eb1' : 'F1', 0.5, 0.8);

  if (withLead) {
    const riff = bar % 2 ? RIFF_B : RIFF_A;
    for (const e of [0, 2, 3, 6]) lead(at(bar, e / 2), riff[e], 0.32, 0.55);
  }
}

function hookBar(bar, { octave = false } = {}) {
  // full drive: kick every beat plus the pickup, snare 2 and 4
  for (const b of [0, 1, 2, 3]) kick(at(bar, b));
  kick(at(bar, 2.5), 0.7);
  snare(at(bar, 1), 0.95);
  snare(at(bar, 3), 0.95);
  hats(bar, { roll: bar % 2 === 1, gain: 0.55 });

  bass(at(bar, 0), 'D1', 0.55);
  bass(at(bar, 1), 'D1', 0.4, 0.8);
  bass(at(bar, 2), 'F1', 0.55);
  bass(at(bar, 3), 'Eb1', 0.4, 0.8);
  bass(at(bar, 3.5), 'D1', 0.3, 0.7);

  const riff = bar % 2 ? RIFF_B : RIFF_A;
  for (let e = 0; e < 8; e++) {
    const n = octave ? UP[riff[e]] : riff[e];
    lead(at(bar, e / 2), n, 0.26, octave ? 0.5 : 0.65);
  }
}

// ---------------------------------------------------------------- arrange --

// intro — bars 0–3
drone(0, at(4, 0) + 0.5, 0.8);
kick(at(0, 0), 0.9);
crash(at(0, 0), 0.5);
kick(at(1, 0), 0.7);
riser(at(1, 0), BAR * 1, 0.6);
kick(at(2, 0));                       // the reveal — head arrives, light on
crash(at(2, 0), 0.8);
bass(at(2, 0), 'D1', 1.4);
lead(at(2, 2), 'D5', 0.5, 0.5);
lead(at(2, 3), 'C5', 0.5, 0.45);
lead(at(3, 0), 'Bb4', 0.8, 0.5);
riser(at(3, 0), BAR, 0.8);
for (let b = 0; b < 4; b++) hat(at(3, b), 0.4);

// groove A — bars 4–8
for (let bar = 4; bar <= 8; bar++) grooveBar(bar, { lead: bar >= 6 });
crash(at(4, 0), 0.6);

// hook — bars 9–15
crash(at(9, 0), 0.9);
for (let bar = 9; bar <= 15; bar++) hookBar(bar);
riser(at(15, 0), BAR, 0.9);

// drop — bars 16–20
crash(at(16, 0), 1);
for (let bar = 16; bar <= 20; bar++) hookBar(bar, { octave: true });

// groove B — bars 21–27
crash(at(21, 0), 0.6);
for (let bar = 21; bar <= 27; bar++) grooveBar(bar, { lead: true, variation: bar % 2 });

// outro — bar 28 to the end
crash(at(28, 0), 0.8);
kick(at(28, 0));
bass(at(28, 0), 'D1', 2.5);
lead(at(28, 0), 'D5', 1.2, 0.5);
lead(at(28, 2), 'D4', 1.6, 0.4);

// ------------------------------------------------------------------ master --

// soft-clip, then a fade over the last two seconds
for (let i = 0; i < buf.length; i++) buf[i] = soft(buf[i] * 0.85);
const fadeN = Math.floor(2 * SR);
for (let i = 0; i < fadeN; i++) buf[buf.length - 1 - i] *= i / fadeN;

// normalise to -1 dBFS
let peak = 0;
for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
const norm = peak ? 0.891 / peak : 1;

// 16-bit mono WAV
const pcm = Buffer.alloc(buf.length * 2);
for (let i = 0; i < buf.length; i++) {
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i] * norm)) * 32767), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22); header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(WAV, Buffer.concat([header, pcm]));

const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', WAV, '-codec:a', 'libmp3lame', '-b:a', '128k', MP3]);
if (ff.status === 0) {
  fs.unlinkSync(WAV);
  console.log(`wrote ${path.relative(process.cwd(), MP3)}  (${Math.round(fs.statSync(MP3).size / 1024)} kB, ${LENGTH_S} s, ${BPM} BPM)`);
} else {
  console.log(`ffmpeg not available — wrote ${path.relative(process.cwd(), WAV)} instead; point _audio.file in dances.json at audio/dakait-beat.wav`);
}
