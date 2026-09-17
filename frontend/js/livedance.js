/* ===========================================================================
 *  livedance.js — the robot dances to whatever is playing in the room.
 *
 *  Runs on /face, the phone already wedged in the robot's head, because that
 *  is the device with a microphone pointed at the room. It listens, tracks the
 *  beat, and sends poses to the server over the same WebSocket the eyes use.
 *
 *  THE LATENCY PROBLEM, AND WHY THIS PREDICTS RATHER THAN REACTS.
 *
 *  Reacting to a beat cannot work here. By the time a kick has been heard,
 *  detected, sent over WiFi and turned into a servo command, the robot has
 *  perhaps 40 ms of slack — and then the horn still needs 500–1000 ms to
 *  travel. It would always be a beat late and look it.
 *
 *  So the loop locks a *period and phase* and schedules moves into the future:
 *
 *    listen ─► onset envelope ─► period (autocorrelation, ~1 Hz update)
 *                             └► phase  (comb, PLL-corrected each estimate)
 *                                  └► predict beat N+1, N+2 …
 *                                       └► send the pose SERVO_LEAD_MS early
 *
 *  `SERVO_LEAD_MS` is the whole trick: the command goes out early by roughly
 *  the time a shoulder takes to travel, so the arm ARRIVES on the beat instead
 *  of setting off on it.
 *
 *  ── WHAT THE MUSIC DECIDES ──────────────────────────────────────────────
 *
 *  Three features, three decisions, measured the same way the offline
 *  generator measures them — per BEAT, ranked against the recent song rather
 *  than against an absolute threshold, because "loud" only means anything
 *  relative to the rest of the track:
 *
 *    LOUDNESS  (weighted low + mid band)  ─►  which TIER of move
 *                                             sway/nod/drift · swagger/point/
 *                                             elbows · crown/pump/hands_up
 *    PITCH     (melodic, via HPS)         ─►  how HIGH the arms and chin go,
 *                                             and which way they are heading
 *    BRIGHTNESS(high band ÷ low band)     ─►  WHICH move inside the tier:
 *                                             dull → compact and low,
 *                                             bright → open and overhead
 *
 *  TWO ANALYSERS, because one cannot do both jobs. Onsets need a short window
 *  to be sharp in time; pitch needs a long one to be sharp in frequency. A
 *  1024-point FFT gives 23 ms resolution and 43 Hz bins — fine for drums,
 *  useless for melody, where a semitone at 200 Hz is 12 Hz. So a second
 *  4096-point analyser runs alongside at 10.8 Hz per bin, and pitch comes off
 *  that through a harmonic product spectrum with parabolic interpolation,
 *  which finds the fundamental rather than whichever harmonic happens to be
 *  loudest.
 *
 *  EVERYTHING IS THE SAME VOCABULARY. Moves come from choreo.js, so a live
 *  dance and an imported one are made of the same steps; only the source of
 *  the beat differs.
 * ========================================================================= */

import { MOVES, HOME } from './choreo.js';

/* How early a pose is sent so the servo ARRIVES on the beat rather than
   leaving on it. Measured from the far end: the firmware slews at 120–180 °/s
   and a big shoulder move is most of a second, but a move is commanded in two
   halves and the second half is a smaller correction, so most of the travel is
   covered by less than a full beat. 260 ms is deliberately shy of the truth —
   arriving a little early reads as anticipation, arriving late reads as lag. */
const SERVO_LEAD_MS = 260;

const FFT = 1024;          // onsets: 23 ms window, sharp in time
const PITCH_FFT = 4096;    // pitch: 10.8 Hz bins, sharp in frequency

/* Band edges in Hz. The split is what lets a bright hi-hat passage and a heavy
   bass drop stop looking identical to a single full-spectrum RMS. */
const BAND = { lowLo: 30, lowHi: 160, midHi: 2000, highHi: 8000 };

/* Melodic range for the pitch tracker. Below this is the bass line, which
   barely moves and would peg the lift; above it is mostly cymbals. */
const PITCH_LO = 110;
const PITCH_HI = 1400;

/* Beats of feature history the ranks are taken against — the live stand-in for
   the offline generator's "rank this bar against the whole song". 64 beats is
   half a minute at 128 BPM: long enough that a chorus reads as louder than a
   verse, short enough to follow a change of track. */
const BEAT_MEMORY = 64;

/* A tier has to be clearly crossed before the moves change, or a rank sitting
   on a boundary makes the robot flip between two vocabularies every bar. */
const TIER_HYSTERESIS = 0.08;
/* How much audio the tempo search looks back over. Held in SECONDS rather
   than in frames: the loop runs on requestAnimationFrame, so a frame count
   means 8 s on a 60 Hz phone and 4 s on a 120 Hz one — and 4 s is not enough
   history to autocorrelate a slow tempo, which showed up as octave errors on
   exactly the fast-display case. Time is the thing that matters here, so time
   is what is kept. */
const HISTORY_MS = 9000;
const HISTORY_MAX = 1400;         // hard cap, so a 240 Hz display cannot run away
const MIN_BPM = 60;
const MAX_BPM = 190;

/* Below this the room is silent and the robot should stand still rather than
   dance to the air conditioning. RMS of the linear spectrum, 0..1. */
const SILENCE = 0.0022;
const SILENT_BARS_BEFORE_IDLE = 2;

const live = {
  on: false,
  ctx: null,
  stream: null,
  analyser: null,
  freq: null,          // Uint8Array, current magnitude spectrum
  prev: null,          // Float32Array, last frame's log magnitudes
  raf: 0,

  onsets: [],          // rolling onset-strength history, newest last
  times: [],           // performance.now() of each of the above — see hopMs()

  pitchAnalyser: null,
  pitchBuf: null,      // Float32Array, dB magnitudes from the long FFT

  /* Features accumulate per frame and are banked once per beat, so every rank
     below is "this beat against the last BEAT_MEMORY beats". */
  acc: null,
  beats: [],           // banked per-beat features, newest last
  tier: 1,             // last tier played — see TIER_HYSTERESIS
  lastPitch: null,     // previous move's pitch, for the rising/falling nudge

  periodMs: 0,         // one beat
  phaseMs: 0,          // performance.now() of a beat, any beat
  confidence: 0,
  lastTempoAt: 0,

  nextBeat: 0,         // when the next beat lands, in performance.now() ms
  beatIndex: 0,
  recent: [],
  silentBars: 0,
  ws: null,
  onStatus: null,
};

// ------------------------------------------------------------------ socket

/* Its own connection rather than borrowing face.js's. face.js is a classic
   script and this is a module, so there is no shared scope to reach into, and
   a second socket is a few bytes a second — cheaper than coupling the two. */
function socket() {
  if (live.ws && live.ws.readyState <= 1) return live.ws;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  live.ws = new WebSocket(`${proto}://${location.host}/ws`);
  live.ws.addEventListener('close', () => { live.ws = null; });
  return live.ws;
}

function send(payload) {
  const ws = socket();
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// ----------------------------------------------------------------- listening

export async function startLive({ onStatus } = {}) {
  if (live.on) return true;
  live.onStatus = onStatus || (() => {});

  let stream;
  try {
    /* Every enhancement off. AGC pumps the level between quiet and loud
       passages, which is exactly the signal the energy tier reads; noise
       suppression and echo cancellation are tuned for speech and chew holes in
       music. What is wanted here is the room, unprocessed.

       Raced against a timeout because getUserMedia does not resolve while a
       permission prompt is on screen, and nobody is standing at the phone to
       answer one — it is inside a robot's head. Without this the face waits
       for ever with its speech recogniser switched off, which looks exactly
       like a crash. */
    stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('no answer — grant the microphone on the phone, then press Live again')), 8000)),
    ]);
  } catch (err) {
    live.onStatus(`microphone: ${err.message || err.name}`);
    return false;
  }

  const Ctx = window.AudioContext || window.webkitAudioContext;
  live.ctx = new Ctx();
  if (live.ctx.state === 'suspended') await live.ctx.resume().catch(() => {});

  live.stream = stream;
  const src = live.ctx.createMediaStreamSource(stream);

  live.analyser = live.ctx.createAnalyser();
  live.analyser.fftSize = FFT;
  live.analyser.smoothingTimeConstant = 0;      // we do our own smoothing
  src.connect(live.analyser);

  /* The long window, for pitch only. Both hang off the same source — an
     AnalyserNode is a tap, not a filter, so this costs one more FFT per frame
     and changes nothing about the signal. */
  live.pitchAnalyser = live.ctx.createAnalyser();
  live.pitchAnalyser.fftSize = PITCH_FFT;
  live.pitchAnalyser.smoothingTimeConstant = 0.2;
  src.connect(live.pitchAnalyser);

  live.freq = new Uint8Array(live.analyser.frequencyBinCount);
  live.prev = new Float32Array(live.analyser.frequencyBinCount);
  live.pitchBuf = new Float32Array(live.pitchAnalyser.frequencyBinCount);
  Object.assign(live, {
    on: true, onsets: [], times: [], beats: [], tier: 1, lastPitch: null, acc: freshAcc(),
    periodMs: 0, phaseMs: 0, confidence: 0, lastTempoAt: 0,
    nextBeat: 0, beatIndex: 0, recent: [], silentBars: 0,
  });

  document.body.classList.add('live-dance');
  live.onStatus('listening…');
  loop();
  return true;
}

export function stopLive() {
  if (!live.on) return;
  live.on = false;
  cancelAnimationFrame(live.raf);
  live.stream?.getTracks().forEach((t) => t.stop());
  live.ctx?.close().catch(() => {});
  Object.assign(live, { ctx: null, stream: null, analyser: null, pitchAnalyser: null, raf: 0 });
  document.body.classList.remove('live-dance');

  // Hand the robot back the way an action does: home, eyes out of DJ mode.
  send({ type: 'pose', pose: { ...HOME } });
  send({ type: 'eyes', eyes: { fx: 'none', auto: true, blink: true, look: 0, speed: 50 } });
  live.onStatus?.('stopped');
}

export const isLive = () => live.on;

// ------------------------------------------------------------------ the loop

function loop() {
  if (!live.on) return;
  live.raf = requestAnimationFrame(loop);
  analyseFrame();
  schedule();
}

/**
 * One frame: spectral flux for the onset envelope, RMS for the energy tier,
 * dominant low-mid bin for the pitch tier. Same three numbers the offline
 * analyser takes per frame, so the tiers mean the same thing in both.
 */
function freshAcc() {
  return { n: 0, low: 0, mid: 0, high: 0, rms: 0, peak: 0, pitches: [] };
}

/**
 * One frame. Band energies and onset flux from the short FFT, melodic pitch
 * from the long one. Everything lands in `live.acc` and is banked per beat.
 */
function analyseFrame() {
  const a = live.analyser;
  a.getByteFrequencyData(live.freq);
  const bins = live.freq.length;
  const binHz = live.ctx.sampleRate / 2 / bins;

  const kLowLo = Math.max(1, Math.floor(BAND.lowLo / binHz));
  const kLowHi = Math.floor(BAND.lowHi / binHz);
  const kMidHi = Math.floor(BAND.midHi / binHz);
  const kHighHi = Math.min(bins - 1, Math.floor(BAND.highHi / binHz));

  let low = 0;
  let mid = 0;
  let high = 0;
  let sq = 0;
  let flux = 0;

  for (let k = 1; k < bins; k++) {
    const v = live.freq[k] / 255;
    sq += v * v;
    if (k >= kLowLo && k <= kLowHi) low += v * v;
    else if (k <= kMidHi) mid += v * v;
    else if (k <= kHighHi) high += v * v;

    const mag = Math.log1p(v * 16);
    const d = mag - live.prev[k];
    /* Onset flux weighted toward the drum end. A vocal swell and a kick are
       the same number to a flat sum, and only one of them is the beat. */
    if (d > 0) flux += d * (k <= kLowHi ? 2.2 : k <= kMidHi ? 1 : 0.35);
    live.prev[k] = mag;
  }

  const acc = live.acc;
  acc.n++;
  acc.low += Math.sqrt(low / Math.max(1, kLowHi - kLowLo));
  acc.mid += Math.sqrt(mid / Math.max(1, kMidHi - kLowHi));
  acc.high += Math.sqrt(high / Math.max(1, kHighHi - kMidHi));
  acc.rms += Math.sqrt(sq / bins);
  if (flux > acc.peak) acc.peak = flux;

  const f0 = detectPitch();
  if (f0) acc.pitches.push(12 * Math.log2(f0 / 440));   // semitones about A4

  const now = performance.now();
  live.onsets.push(flux);
  live.times.push(now);
  trim(now);

  // Re-estimate the tempo about once a second; it is the expensive part.
  if (now - live.times[0] > 4000 && now - live.lastTempoAt > 900) {
    live.lastTempoAt = now;
    estimateTempo(now);
  }
}

/**
 * Melodic pitch by harmonic product spectrum.
 *
 * The loudest bin is not the note: a voice or a lead is a stack of harmonics
 * and the second or third is often the strongest, so "argmax" jumps an octave
 * whenever the timbre changes. Multiplying the spectrum by itself decimated
 * 2x and 3x lines every harmonic up on the fundamental, which then wins by a
 * wide margin. Parabolic interpolation on the peak recovers a fraction of a
 * bin, which matters because one bin is already most of a semitone up here.
 *
 * Returns Hz, or 0 when nothing in the band is confidently pitched.
 */
function detectPitch() {
  const pa = live.pitchAnalyser;
  pa.getFloatFrequencyData(live.pitchBuf);        // dBFS, -Infinity when empty
  const buf = live.pitchBuf;
  const bins = buf.length;
  const binHz = live.ctx.sampleRate / 2 / bins;

  const kLo = Math.max(2, Math.floor(PITCH_LO / binHz));
  const kHi = Math.min(Math.floor(bins / 3) - 1, Math.ceil(PITCH_HI / binHz));
  if (kHi <= kLo) return 0;

  const lin = (k) => {
    const db = buf[k];
    return db > -100 && Number.isFinite(db) ? Math.pow(10, db / 20) : 1e-6;
  };

  let bestK = 0;
  let bestV = 0;
  let sum = 0;
  for (let k = kLo; k <= kHi; k++) {
    const v = lin(k) * lin(k * 2) * lin(k * 3);
    sum += v;
    if (v > bestV) { bestV = v; bestK = k; }
  }
  if (!bestK) return 0;

  /* Confidence: the peak has to stand out from the band, or this is noise
     with a winner rather than a note. */
  const mean = sum / (kHi - kLo + 1);
  if (!(bestV > mean * 8)) return 0;

  // parabolic interpolation in the log domain, on the HPS itself
  const y0 = Math.log(lin(bestK - 1) * lin((bestK - 1) * 2) * lin((bestK - 1) * 3) + 1e-30);
  const y1 = Math.log(bestV + 1e-30);
  const y2 = Math.log(lin(bestK + 1) * lin((bestK + 1) * 2) * lin((bestK + 1) * 3) + 1e-30);
  const den = y0 - 2 * y1 + y2;
  const shift = den < 0 ? 0.5 * (y0 - y2) / den : 0;
  return (bestK + Math.max(-1, Math.min(1, shift))) * binHz;
}

/**
 * Close off the beat that just ended and file its features.
 *
 * Per beat rather than per frame because that is the unit the choreography is
 * written in, and because a frame-level distribution is dominated by the
 * envelope inside each beat — every beat has a loud attack and a quiet tail,
 * so ranking frames against frames says almost nothing about which beat is
 * the loud one.
 */
function bankBeat() {
  const acc = live.acc;
  live.acc = freshAcc();
  if (!acc.n) return;

  const low = acc.low / acc.n;
  const mid = acc.mid / acc.n;
  const high = acc.high / acc.n;

  live.beats.push({
    /* Loudness weighted toward what carries a groove. Hi-hats are loud in a
       flat RMS and contribute almost nothing to how big a move should be. */
    loud: low * 1.6 + mid,
    rms: acc.rms / acc.n,
    /* Brightness as a ratio, logged so it is symmetric about "balanced" —
       an absolute high-band level would just track the volume. */
    bright: Math.log((high + 1e-5) / (low + mid + 1e-5)),
    pitch: acc.pitches.length ? median(acc.pitches) : null,
    peak: acc.peak,
  });
  if (live.beats.length > BEAT_MEMORY) live.beats.shift();
}

/** Drop anything older than HISTORY_MS, keeping the four buffers in step. */
function trim(now) {
  let drop = 0;
  while (drop < live.times.length - 2 &&
         (now - live.times[drop] > HISTORY_MS || live.times.length - drop > HISTORY_MAX)) drop++;
  if (!drop) return;
  live.times.splice(0, drop);
  live.onsets.splice(0, drop);
}

/**
 * Period by autocorrelation of the onset envelope, phase by combing the
 * envelope with the winning period. Same method as the offline analyser, on a
 * rolling window instead of a whole file.
 */
function estimateTempo(now) {
  const x = live.onsets;
  const n = x.length;

  /* The hop is MEASURED, not assumed. This loop runs on requestAnimationFrame,
     so the spacing between analyses is the display's frame interval — about
     16.7 ms at 60 Hz, 8.3 ms at 120 Hz, and whatever thermal throttling makes
     it on a hot phone. Assuming a rate here put every tempo out by the ratio
     between the guess and the truth: a 43 Hz assumption on a 60 Hz phone reads
     102 BPM as 142. Taking it from the timestamps costs nothing and is right
     on any device. */
  const hopMs = (live.times[n - 1] - live.times[0]) / (n - 1);
  if (!(hopMs > 0)) return;

  // local-mean subtraction leaves the spikes and drops the wash
  const env = new Float64Array(n);
  const W = 8;
  for (let i = 0; i < n; i++) {
    let m = 0;
    let c = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) { m += x[j]; c++; }
    env[i] = Math.max(0, x[i] - m / c);
  }

  const minLag = Math.round(60000 / MAX_BPM / hopMs);
  const maxLag = Math.min(n - 4, Math.round(60000 / MIN_BPM / hopMs));
  let bestLag = 0;
  let bestScore = 0;
  let total = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = lag; i < n; i++) acc += env[i] * env[i - lag];
    acc /= (n - lag);
    const bpm = 60000 / (lag * hopMs);
    // the same mild pull toward 80–140 that settles double/half time
    const prior = Math.exp(-0.5 * Math.pow(Math.log(bpm / 110) / 0.45, 2));
    const score = acc * (0.55 + 0.45 * prior);
    total += score;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (!bestLag) return;

  /* Octave correction. Autocorrelation is blind to the difference between a
     beat and every other beat, and weighting the flux toward the kick made it
     likelier to pick double time — a snare on the off-beat looks exactly like
     a kick to a peak finder. So if HALF this tempo is also in range and nearly
     as strong, take the slower reading: it is the commoner musical truth, and
     on a servo robot a move that gets twice as long to travel is the better
     failure anyway. */
  const half = bestLag * 2;
  if (half <= maxLag) {
    let acc = 0;
    for (let i = half; i < n; i++) acc += env[i] * env[i - half];
    acc /= (n - half);
    const halfBpm = 60000 / (half * hopMs);
    const halfPrior = Math.exp(-0.5 * Math.pow(Math.log(halfBpm / 110) / 0.45, 2));
    if (acc * (0.55 + 0.45 * halfPrior) > bestScore * 0.82) bestLag = half;
  }

  /* How much the winner stands out from the field. A room with music in it
     gives a sharp peak; a room with talking gives mush, and mush must not be
     allowed to drive the arms. */
  const mean = total / (maxLag - minLag + 1);
  live.confidence = mean > 0 ? Math.min(1, (bestScore / mean - 1) / 2) : 0;

  const periodMs = bestLag * hopMs;

  // phase: the offset whose beats collect the most onset energy
  let bestPhase = 0;
  let phaseScore = -1;
  for (let p = 0; p < bestLag; p += 0.5) {
    let acc = 0;
    for (let i = p; i < n; i += bestLag) acc += env[Math.round(i)] || 0;
    if (acc > phaseScore) { phaseScore = acc; bestPhase = p; }
  }

  /* The newest sample sits at the last timestamp; walk the grid forward from
     the phase offset to the first beat that has not happened yet. */
  const gridStartMs = live.times[n - 1] - (n - 1 - bestPhase) * hopMs;
  const ahead = Math.ceil((now - gridStartMs) / periodMs);
  const nextBeat = gridStartMs + ahead * periodMs;

  const hadLock = live.periodMs > 0;
  const changed = !hadLock || Math.abs(periodMs - live.periodMs) / live.periodMs > 0.04;

  live.periodMs = periodMs;
  if (!hadLock || changed) {
    live.nextBeat = nextBeat;
    live.beatIndex = 0;
  } else {
    /* Track the phase continuously rather than only on a tempo change.
       Between estimates the grid free-runs on nextBeat += periodMs, and a
       period that is off by even 1 BPM walks the downbeat off the music a
       percent at a time — which is exactly what it looks like: a robot that
       starts on the beat and is half a beat out a verse later.
       Correct a quarter of the error each time, the usual PLL compromise:
       enough to hold the lock, gentle enough that one bad estimate in a noisy
       room cannot yank the arms out of time. */
    let err = (nextBeat - live.nextBeat) % periodMs;
    if (err > periodMs / 2) err -= periodMs;
    if (err < -periodMs / 2) err += periodMs;
    live.nextBeat += err * 0.25;
  }

  const bpm = Math.round(60000 / periodMs);
  if (changed && live.confidence > 0.15) {
    // the phone face pulses to whatever is actually playing
    send({ type: 'eyes', eyes: { fx: 'dj', bpm, auto: false } });
    live.onStatus(`${bpm} BPM · lock ${Math.round(live.confidence * 100)}%`);
  }
}

// --------------------------------------------------------------- scheduling

/**
 * Fire a move when the next downbeat is SERVO_LEAD_MS away.
 *
 * A move takes two bars at a fast tempo and one at a slow one, the same rule
 * the offline generator uses, so the arms always get about four beats to
 * travel however quick the music is.
 */
function schedule() {
  if (!live.periodMs || !live.nextBeat) return;
  const now = performance.now();

  // beats that have already gone by while the tab was busy
  while (now - live.nextBeat > live.periodMs) {
    bankBeat();
    live.nextBeat += live.periodMs;
    live.beatIndex++;
  }

  const bpm = 60000 / live.periodMs;
  const beatsPerMove = bpm > 130 ? 8 : 4;
  const untilBeat = live.nextBeat - now;

  if (untilBeat > SERVO_LEAD_MS) return;              // not yet
  if (live.beatIndex % beatsPerMove !== 0) {          // not a move boundary
    bankBeat();
    live.nextBeat += live.periodMs;
    live.beatIndex++;
    return;
  }

  bankBeat();
  fireMove(beatsPerMove, bpm);
  live.nextBeat += live.periodMs;
  live.beatIndex++;
}

/**
 * Where this beat sits among the last BEAT_MEMORY beats, 0..1.
 *
 * A percentile, not a distance from the mean: music is not normally
 * distributed, and one enormous drop would otherwise flatten every rank after
 * it. The offline generator ranks bars against the whole song the same way.
 */
function rankIn(key, value) {
  const hist = live.beats.filter((h) => h[key] != null);
  if (hist.length < 6 || value == null) return 0.5;
  let below = 0;
  for (const h of hist) if (h[key] < value) below++;
  return below / hist.length;
}

function median(a) {
  const s = a.slice().sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
}

/**
 * Which move, inside a tier, brightness chooses.
 *
 * Each pool is ordered dull → bright, which in this vocabulary is also
 * compact → open: a bass-heavy passage gets the low, folded gestures and a
 * cymbal-heavy one gets the arms overhead. That is a real musical mapping
 * rather than the hash the offline generator uses, which can afford to be
 * arbitrary because it sees the whole song and only needs variety.
 */
const BY_BRIGHTNESS = [
  ['nod', 'sway', 'drift'],
  ['swagger', 'elbows', 'point'],
  ['pump', 'crown', 'hands_up'],
];

function chooseMove(tier, brightRank) {
  const pool = BY_BRIGHTNESS[tier];
  const idx = Math.min(pool.length - 1, Math.floor(brightRank * pool.length));
  let name = pool[idx];
  // never three running — nudge along the pool rather than jumping tier
  if (live.recent.length >= 2 && live.recent[0] === name && live.recent[1] === name) {
    name = pool[(idx + 1) % pool.length];
  }
  return name;
}

function fireMove(beatsPerMove, bpm) {
  const b = live.periodMs;
  const hist = live.beats;
  const last = hist[hist.length - 1];
  if (!last) return;

  const loudNow = median(hist.slice(-Math.max(2, beatsPerMove)).map((h) => h.rms));

  // Silence, or no confident beat: stand down rather than dance to the room.
  if (loudNow < SILENCE || live.confidence < 0.12) {
    if (++live.silentBars >= SILENT_BARS_BEFORE_IDLE) {
      send({ type: 'pose', pose: { ...HOME } });
      live.onStatus(live.confidence < 0.12 ? 'no beat — waiting' : 'quiet — waiting');
      live.silentBars = SILENT_BARS_BEFORE_IDLE;      // stay parked, do not count up
    }
    return;
  }
  live.silentBars = 0;

  /* The move is chosen from the beats that are ABOUT to be danced over, which
     are the ones just banked — a move spans several beats, so one beat's
     numbers would be whichever fraction of the bar happened to land last. */
  const span = hist.slice(-beatsPerMove);
  const loud = median(span.map((h) => h.loud));
  const bright = median(span.map((h) => h.bright));
  const pitched = span.map((h) => h.pitch).filter((v) => v != null);
  const pitch = pitched.length ? median(pitched) : null;

  const energyRank = rankIn('loud', loud);
  const brightRank = rankIn('bright', bright);
  const pitchRank = rankIn('pitch', pitch);

  /* Tier, with hysteresis: a rank sitting on a boundary would otherwise flip
     the whole vocabulary every bar. */
  const raw = energyRank < 0.34 ? 0 : energyRank < 0.67 ? 1 : 2;
  let tier = live.tier;
  if (raw > tier && energyRank > (tier === 0 ? 0.34 : 0.67) + TIER_HYSTERESIS) tier = raw;
  else if (raw < tier && energyRank < (tier === 2 ? 0.67 : 0.34) - TIER_HYSTERESIS) tier = raw;
  live.tier = tier;

  /* Pitch decides how high the arms and chin go, and which way they are
     heading — a rising line lifts a little further than a flat one sitting at
     the same height, which is what makes a climb read as a climb. */
  const prevPitch = live.lastPitch;
  const dir = pitch != null && prevPitch != null ? Math.sign(pitch - prevPitch) : 0;
  if (pitch != null) live.lastPitch = pitch;
  const lift = Math.round((pitchRank - 0.5) * 26 + dir * 6);

  const name = chooseMove(tier, brightRank);
  live.recent.unshift(name);
  if (live.recent.length > 2) live.recent.pop();

  /* The move's own step list, in ms. Rather than replaying it through a timer
     chain — which would drift against the beat the moment the tempo moved —
     each step is sent on its own predicted beat, so a tempo change between the
     halves of a move is simply followed. */
  const u = (beatsPerMove / 2) * b;
  const steps = MOVES[name](u, b, lift).filter((s) => s.pose);

  let at = 0;
  for (const step of steps) {
    const delay = Math.max(0, at - SERVO_LEAD_MS);
    if (delay < 8) send({ type: 'pose', pose: step.pose });
    else setTimeout(() => { if (live.on) send({ type: 'pose', pose: step.pose }); }, delay);
    at += step.ms;
  }

  /* A beat whose onset peak stands above the recent field gets the light, the
     same accent the offline generator puts on the top tenth of bars. */
  if (rankIn('peak', last.peak) > 0.9) {
    send({ type: 'light', on: true });
    setTimeout(() => { if (live.on) send({ type: 'light', on: false }); }, Math.min(300, b / 2));
  }

  // Eyes elsewhere every fourth move, the same tic the offline routines have.
  if (live.beatIndex % (beatsPerMove * 4) === 0) {
    send({ type: 'eyes', eyes: { look: Math.random() < 0.5 ? -80 : 80, speed: 40, auto: false } });
  }

  const note = pitch == null ? '--' : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((Math.round(pitch) + 9) % 12 + 12) % 12];
  live.onStatus(
    `${Math.round(bpm)} BPM · ${name} · E${Math.round(energyRank * 100)} ` +
    `B${Math.round(brightRank * 100)} P${Math.round(pitchRank * 100)}${note}`);
}

/* face.js is a classic script and cannot import a module, so publish the three
   entry points it needs on the window. This is the only global here. */
window.liveDance = { start: startLive, stop: stopLive, isLive };
