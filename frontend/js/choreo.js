/* ===========================================================================
 *  choreo.js — turns a piece of music into a dance routine for the robot.
 *
 *  Two stages, both pure functions so they can be run in Node against a WAV
 *  as easily as in the browser against a decoded AudioBuffer:
 *
 *    analyse(samples, sampleRate, { start, end })  ->  features
 *    choreograph(features, { id, label, audioFile }) ->  a dance object for
 *                                                          config/dances.json
 *
 *  ANALYSIS. The signal is cut into 2048-sample frames every 512 samples and
 *  each frame goes through an FFT (radix-2, written here — no dependencies is
 *  a rule of this project). From the spectrum, per frame:
 *
 *    flux      how much louder the spectrum got since the last frame; this is
 *              the onset envelope, and drums are what make it spike
 *    energy    RMS loudness
 *    low       energy below 160 Hz — the kick and the 808
 *    centroid  the spectrum's centre of mass in Hz — brightness
 *    pitch     the strongest bin between 60 Hz and 1.2 kHz — the note
 *
 *  Tempo is the lag at which the onset envelope best correlates with itself,
 *  searched over 60–200 BPM with a mild pull toward the 80–140 range, which
 *  is where the autocorrelation's octave errors (double- and half-time) are
 *  resolved. Beat phase is the offset that lines the grid up with the most
 *  onset energy; the downbeat is whichever of the four beat positions carries
 *  the most low end, because the kick lands on the one.
 *
 *  CHOREOGRAPHY. The routine is written bar by bar. Two numbers decide the
 *  move for a bar, both relative to the track itself rather than absolute:
 *
 *    energy rank   how loud this bar is against the rest of the song — picks
 *                  how BIG the move is (sway / swagger / crown)
 *    pitch rank    how high this bar's note sits against the rest — picks how
 *                  HIGH the arms and head go, as an offset on the move
 *
 *  A rising pitch lifts the arms across the bar; falling lowers them. A bar
 *  whose onset peak is in the top tenth gets an accent: the light flashes and
 *  the head snaps up. Every fourth bar the eyes look somewhere else. Moves are
 *  never repeated more than twice running, and the choice is a hash of the bar
 *  index and its features, so the same trim of the same song gives the same
 *  routine every time. With `holdHook`, the first move the loudest tier reaches
 *  is treated as the song's hook step and kept for every bar after it — the
 *  pose numbers still breathe with each bar's pitch, so it repeats without
 *  freezing.
 *
 *  THE ROBOT IS SLOW. Every dwell is a whole number of beats and no arm move
 *  is shorter than two beats; above 130 BPM a move spans two bars rather than
 *  one, so it still gets four beats to travel in, because the
 *  firmware slews each servo at 120–180 °/s and a big shoulder move needs about
 *  a second to actually arrive. The head and the light are quick and may take
 *  a single beat. Only three motors per arm are used — shoulder_x, shoulder_y,
 *  elbow; wrists and grippers are never touched. The generator never emits
 *  `drive`.
 * ========================================================================= */

// ------------------------------------------------------------------- FFT --

/** In-place radix-2 FFT. re/im are Float64Arrays whose length is a power of two. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// -------------------------------------------------------------- analysis --

const FRAME = 2048;
const HOP = 512;

/**
 * samples: Float32Array | Float64Array, mono.
 * Returns { bpm, beatMs, beats[], bars[], leadIn, duration, frames }.
 * Times in `beats`/`bars` are seconds from the START OF THE TRIM, not the file.
 */
export function analyse(samples, sampleRate, { start = 0, end = null } = {}) {
  const s0 = Math.max(0, Math.floor(start * sampleRate));
  const s1 = Math.min(samples.length, Math.floor((end == null ? samples.length / sampleRate : end) * sampleRate));
  const x = samples.subarray(s0, s1);
  const duration = x.length / sampleRate;
  if (duration < 4) throw new Error('need at least 4 seconds of audio');

  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

  const nFrames = Math.max(1, Math.floor((x.length - FRAME) / HOP) + 1);
  const binHz = sampleRate / FRAME;
  const lowBin = Math.ceil(160 / binHz);
  const pitchLo = Math.ceil(60 / binHz);
  const pitchHi = Math.floor(1200 / binHz);

  const flux = new Float64Array(nFrames);
  const energy = new Float64Array(nFrames);
  const low = new Float64Array(nFrames);
  const centroid = new Float64Array(nFrames);
  const pitch = new Float64Array(nFrames);

  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = new Float64Array(FRAME / 2);
  let cur = new Float64Array(FRAME / 2);

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    let sq = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = x[off + i] || 0;
      re[i] = v * window[i];
      im[i] = 0;
      sq += v * v;
    }
    energy[f] = Math.sqrt(sq / FRAME);
    fft(re, im);

    let fl = 0;
    let lo = 0;
    let cSum = 0;
    let mSum = 0;
    let pBest = 0;
    let pBin = 0;
    for (let k = 1; k < FRAME / 2; k++) {
      const mag = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      cur[k] = mag;
      const d = mag - prev[k];
      if (d > 0) fl += d;
      if (k < lowBin) lo += mag;
      cSum += k * mag;
      mSum += mag;
      if (k >= pitchLo && k <= pitchHi && mag > pBest) { pBest = mag; pBin = k; }
    }
    flux[f] = fl;
    low[f] = lo;
    centroid[f] = mSum ? (cSum / mSum) * binHz : 0;
    pitch[f] = pBin * binHz;
    const t = prev; prev = cur; cur = t;
  }

  // --- tempo -------------------------------------------------------------

  const frameSec = HOP / sampleRate;
  const onset = new Float64Array(nFrames);
  {
    // local-mean subtraction, then half-wave: leaves the spikes, drops the wash
    const W = 8;
    for (let i = 0; i < nFrames; i++) {
      let m = 0;
      let c = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(nFrames - 1, i + W); j++) { m += flux[j]; c++; }
      onset[i] = Math.max(0, flux[i] - m / c);
    }
  }

  const minLag = Math.round(60 / 200 / frameSec);
  const maxLag = Math.round(60 / 60 / frameSec);
  let bestLag = minLag;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = lag; i < nFrames; i++) acc += onset[i] * onset[i - lag];
    const bpm = 60 / (lag * frameSec);
    // mild log-normal prior around 110 BPM — settles the octave, does not pick the tempo
    const prior = Math.exp(-0.5 * Math.pow(Math.log(bpm / 110) / 0.45, 2));
    const score = (acc / (nFrames - lag)) * (0.55 + 0.45 * prior);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  // sub-frame refinement: parabolic fit on the autocorrelation around the peak
  const ac = (lag) => {
    let a = 0;
    for (let i = lag; i < nFrames; i++) a += onset[i] * onset[i - lag];
    return a / (nFrames - lag);
  };
  let lagF = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = ac(bestLag - 1); const y1 = ac(bestLag); const y2 = ac(bestLag + 1);
    const den = y0 - 2 * y1 + y2;
    if (den < 0) lagF = bestLag + 0.5 * (y0 - y2) / den;
  }
  const beatSec = lagF * frameSec;
  const bpm = Math.round(60 / beatSec);

  // --- beat phase ----------------------------------------------------------

  const period = beatSec / frameSec;
  let bestPhase = 0;
  let phaseScore = -1;
  for (let p = 0; p < period; p += 0.5) {
    let acc = 0;
    for (let i = p; i < nFrames; i += period) acc += onset[Math.round(i)] || 0;
    if (acc > phaseScore) { phaseScore = acc; bestPhase = p; }
  }
  const beats = [];
  for (let i = bestPhase; i < nFrames; i += period) beats.push(i * frameSec);

  // --- downbeat: the beat position with the most low end -----------------

  let downbeat = 0;
  let dbScore = -1;
  for (let d = 0; d < 4; d++) {
    let acc = 0;
    let c = 0;
    for (let b = d; b < beats.length; b += 4) {
      const f = Math.round(beats[b] / frameSec);
      acc += low[f] || 0;
      c++;
    }
    if (c && acc / c > dbScore) { dbScore = acc / c; downbeat = d; }
  }

  // --- bars ----------------------------------------------------------------

  const bars = [];
  for (let b = downbeat; b + 3 < beats.length; b += 4) {
    const t0 = beats[b];
    const t1 = beats[b + 3] + beatSec;
    const f0 = Math.round(t0 / frameSec);
    const f1 = Math.min(nFrames, Math.round(t1 / frameSec));
    if (f1 - f0 < 2) continue;
    let e = 0;
    let lo = 0;
    let c = 0;
    let peak = 0;
    let hits = 0;
    const ps = [];
    const thr = percentile(onset, 0.85);
    for (let f = f0; f < f1; f++) {
      e += energy[f]; lo += low[f]; c += centroid[f];
      if (onset[f] > peak) peak = onset[f];
      if (onset[f] > thr) hits++;
      if (energy[f] > 0.01) ps.push(pitch[f]);
    }
    const n = f1 - f0;
    bars.push({
      t: t0,
      energy: e / n,
      low: lo / n,
      centroid: c / n,
      pitch: ps.length ? median(ps) : 0,
      peak,
      hits,
    });
  }
  if (!bars.length) throw new Error('could not find a bar grid — try a longer or louder section');

  // ranks: where each bar sits against the rest of the song, 0..1
  rank(bars, 'energy', 'energyRank');
  rank(bars, 'pitch', 'pitchRank');
  rank(bars, 'centroid', 'brightRank');
  rank(bars, 'peak', 'peakRank');

  return {
    bpm,
    beatMs: Math.round(beatSec * 1000),
    beats,
    bars,
    leadIn: bars[0].t,
    duration,
    frames: nFrames,
  };
}

function percentile(arr, p) {
  const a = Array.from(arr).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function rank(items, key, out) {
  const order = items.map((it, i) => [it[key], i]).sort((a, b) => a[0] - b[0]);
  const n = Math.max(1, order.length - 1);
  order.forEach(([, i], r) => { items[i][out] = r / n; });
}

// ------------------------------------------------------------ choreography --

export const HOME = {
  right_shoulder_x: 0, right_shoulder_y: 0, right_elbow: 0,
  left_shoulder_x: 0, left_shoulder_y: 0, left_elbow: 0,
  head_tilt: 50,
};

export const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * The move library. Each returns the steps for ONE bar. `u` is the arm unit
 * in ms (two or four beats), `b` one beat; `lift` is added to every
 * shoulder_y and subtracted from head_tilt (higher note, higher arms, chin up).
 *
 * Three motors per arm and nothing else: shoulder_x (forward), shoulder_y
 * (sideways lift), elbow. The wrists and grippers are deliberately never
 * touched — the fast one-beat accents that used to be gripper snaps and wrist
 * rolls are done with the elbows, the head and the light instead.
 */
export const MOVES = {
  // --- low energy ---
  sway: (u, b, lift) => [
    { pose: { right_shoulder_x: 10, right_shoulder_y: clamp(30 + lift), right_elbow: 40, left_shoulder_x: 10, left_shoulder_y: clamp(12 + lift), left_elbow: 20, head_tilt: clamp(46 - lift) }, ms: u },
    { pose: { right_shoulder_y: clamp(12 + lift), right_elbow: 20, left_shoulder_y: clamp(30 + lift), left_elbow: 40, head_tilt: clamp(54 - lift) }, ms: u },
  ],
  nod: (u, b, lift) => [
    { pose: { head_tilt: clamp(60 - lift) }, ms: u },
    { pose: { head_tilt: clamp(38 - lift) }, ms: u },
  ],
  drift: (u, b, lift) => [
    { pose: { right_shoulder_x: 24, right_elbow: 30, left_shoulder_x: 24, left_elbow: 30, right_shoulder_y: clamp(18 + lift), left_shoulder_y: clamp(18 + lift), head_tilt: clamp(48 - lift) }, eyes: { look: -70 }, ms: u },
    { eyes: { look: 70 }, ms: u },
  ],
  // --- mid energy ---
  swagger: (u, b, lift) => [
    { pose: { right_shoulder_x: 20, right_shoulder_y: clamp(46 + lift), right_elbow: 62, left_shoulder_x: 20, left_shoulder_y: clamp(16 + lift), left_elbow: 22, head_tilt: clamp(42 - lift) }, ms: u },
    { pose: { right_shoulder_y: clamp(16 + lift), right_elbow: 22, left_shoulder_y: clamp(46 + lift), left_elbow: 62, head_tilt: clamp(56 - lift) }, ms: u },
  ],
  point: (u, b, lift) => [
    { pose: { right_shoulder_x: 42, right_shoulder_y: clamp(30 + lift), right_elbow: 78, left_shoulder_x: 12, left_shoulder_y: clamp(18 + lift), left_elbow: 30, head_tilt: clamp(50 - lift) }, ms: u },
    { pose: { right_shoulder_x: 70, right_elbow: 16, head_tilt: clamp(36 - lift) }, ms: u },
  ],
  elbows: (u, b, lift) => [
    { pose: { right_shoulder_x: 30, left_shoulder_x: 30, right_shoulder_y: clamp(24 + lift), left_shoulder_y: clamp(24 + lift), right_elbow: 80, left_elbow: 15, head_tilt: clamp(46 - lift) }, ms: u },
    { pose: { right_elbow: 15, left_elbow: 80 }, ms: u },
  ],
  // --- high energy ---
  crown: (u, b, lift) => [
    { pose: { right_shoulder_x: 18, right_shoulder_y: clamp(72 + lift), right_elbow: 24, left_shoulder_x: 18, left_shoulder_y: clamp(72 + lift), left_elbow: 24, head_tilt: clamp(28 - lift) }, ms: u },
    { pose: { head_tilt: clamp(40 - lift) }, light: false, ms: b },
    { pose: { head_tilt: clamp(26 - lift) }, light: true, ms: b },
    ...(u > 2 * b ? [{ pose: { head_tilt: clamp(40 - lift) }, light: false, ms: b }, { pose: { head_tilt: clamp(26 - lift) }, light: true, ms: b }] : []),
  ],
  pump: (u, b, lift) => [
    { pose: { right_shoulder_x: 10, right_shoulder_y: clamp(74 + lift), right_elbow: 60, left_shoulder_x: 10, left_shoulder_y: clamp(20 + lift), left_elbow: 20, head_tilt: clamp(40 - lift) }, ms: u },
    { pose: { right_shoulder_y: clamp(20 + lift), right_elbow: 20, left_shoulder_y: clamp(74 + lift), left_elbow: 60, head_tilt: clamp(58 - lift) }, ms: u },
  ],
  hands_up: (u, b, lift) => [
    { pose: { right_shoulder_x: 0, right_shoulder_y: clamp(96 + lift), right_elbow: 70, left_shoulder_x: 0, left_shoulder_y: clamp(96 + lift), left_elbow: 20, head_tilt: clamp(30 - lift) }, ms: u },
    { pose: { right_elbow: 20, left_elbow: 70 }, ms: u },
  ],
};

export const TIERS = [
  ['sway', 'nod', 'drift'],
  ['swagger', 'point', 'elbows'],
  ['crown', 'pump', 'hands_up'],
];

/** energyRank 0..1 -> which row of TIERS. */
export const tierOf = (energyRank) => (energyRank < 0.34 ? 0 : energyRank < 0.67 ? 1 : 2);

/**
 * Choose a move. Shared by the offline generator and the live driver so both
 * speak the same vocabulary — `recent` is a short list of what just played,
 * and a move is not allowed three bars running.
 */
export function pickMove(tier, seed, recent = []) {
  const pool = TIERS[tier];
  let name = pool[seed % pool.length];
  if (recent.length >= 2 && recent[0] === name && recent[1] === name) {
    name = pool[(pool.indexOf(name) + 1) % pool.length];
  }
  return name;
}

/* Deterministic pick: the same bar of the same song always gets the same move,
   so a routine can be regenerated without changing under somebody's feet. */
export function hash(...nums) {
  let h = 2166136261;
  for (const n of nums) {
    h ^= Math.round(n * 1000) & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * features: from analyse(). opts: { id, label, audioFile, audioStart }.
 * Returns a dance object ready for POST /api/dances.
 */
export function choreograph(features, { id, label, audioFile, audioStart = 0, sourceName = '', holdHook = false } = {}) {
  const { bpm, beatMs, bars, leadIn } = features;
  const b = beatMs;

  /* How much music one move gets, and how long each of its two halves lasts.
     Above 130 BPM a bar is too short for a shoulder to arrive in, so a move
     takes TWO bars instead of being crammed into one — the arm unit stays two
     beats' worth of travel either way, it just gets four beats to do it in.
     Widening `u` alone was the bug: a two-step move then wanted 8 beats of a
     4-beat bar, and every routine on a fast track ran long and drifted off
     the music. */
  const fast = bpm > 130;
  const barsPerMove = fast ? 2 : 1;
  const beatsPerMove = 4 * barsPerMove;
  const u = (beatsPerMove / 2) * b;            // the arm unit — see the header
  const steps = [];
  let total = 0;
  const push = (step, note) => {
    if (note) steps.push(note);
    steps.push(step);
    total += step.ms;
  };

  // --- arrival: dark, bowed, eyes shut; the DJ vibe starts first ------------
  const lead = Math.round(leadIn * 1000);
  push({
    pose: { ...HOME, head_tilt: 92 },
    eyes: { fx: 'dj', bpm, lids: 'closed', blink: false, speed: 18, auto: false, look: 0 },
    light: false,
    ms: Math.max(300, lead || b),
  }, `--- arrival · ${bpm} BPM, ${bars.length} bars, ${beatsPerMove} beats per move, arm unit ${u} ms ---`);

  // --- the reveal on bar 1 ----------------------------------------------------
  push({ pose: { head_tilt: 38 }, eyes: { lids: 'open', speed: 30, blink: true }, light: true, ms: u }, '--- reveal ---');
  push({ pose: { head_tilt: 46 }, eyes: { look: -80, speed: 30 }, ms: 4 * b - u > 0 ? 4 * b - u : b });

  // --- the body: one move per bar ---------------------------------------------
  const recent = [];
  let lastLook = -80;
  /* holdHook: the first move the loudest tier reaches is the song's hook step,
     and once it has been seen it is kept for the rest of the routine instead
     of the moves carrying on rotating. The pose numbers still breathe with
     each bar's pitch, so it repeats without freezing — which is what a hook
     does, and what somebody watching expects to keep seeing. */
  let hookMove = null;
  for (let i = barsPerMove; i + barsPerMove - 1 < bars.length; i += barsPerMove) {
    const bar = bars[i];
    const prevBar = bars[i - barsPerMove];
    const tier = tierOf(bar.energyRank);

    // pitch: where this bar sits in the song's range, and which way it is going
    const lift = Math.round((bar.pitchRank - 0.5) * 24 + Math.sign(bar.pitch - prevBar.pitch) * 6);

    // pick a move from the tier, never the same one three bars running
    let name;
    if (holdHook && hookMove) {
      name = hookMove;                     // the hook, held to the end
    } else {
      name = pickMove(tier, hash(i, bar.energy, bar.pitch, bar.centroid), recent);
      if (holdHook && tier === 2) hookMove = name;
    }
    recent.unshift(name);
    if (recent.length > 2) recent.pop();

    const moveSteps = MOVES[name](u, b, lift);
    const note = `bar ${i + 1} · ${name}${holdHook && hookMove === name ? ' (hook, held)' : ''} · energy ${bar.energyRank.toFixed(2)} pitch ${bar.pitchRank.toFixed(2)}${bar.peakRank > 0.9 ? ' · ACCENT' : ''}`;

    // accent: a bar whose onset peak is in the top tenth gets the light and a head snap
    if (bar.peakRank > 0.9) {
      moveSteps[0] = { ...moveSteps[0], light: false, pose: { ...moveSteps[0].pose, head_tilt: clamp(30 - lift) } };
      moveSteps.splice(1, 0, { light: true, ms: b });
      // keep the move its full length: shave the beat off the last arm step
      const last = moveSteps[moveSteps.length - 1];
      if (last.ms > b) last.ms -= b; else moveSteps.pop();
    }

    // every fourth bar the eyes go somewhere else
    if (i % 4 === 0) {
      lastLook = lastLook > 0 ? -80 : 80;
      moveSteps[0] = { ...moveSteps[0], eyes: { ...(moveSteps[0].eyes || {}), look: lastLook, speed: 40 } };
    }

    /* A move occupies exactly its share of the music; whatever the steps added
       up to, make it so. The shortfall goes on the last step, and if that
       would drive it under a beat the overflow is taken off the first instead
       — so the grid holds rather than the bar quietly growing. */
    const budget = beatsPerMove * b;
    let moveMs = moveSteps.reduce((s, st) => s + st.ms, 0);
    if (moveMs !== budget) {
      const last = moveSteps[moveSteps.length - 1];
      const want = last.ms + (budget - moveMs);
      last.ms = Math.max(b, want);
      moveMs = moveSteps.reduce((s, st) => s + st.ms, 0);
      if (moveMs > budget) moveSteps[0].ms = Math.max(b, moveSteps[0].ms - (moveMs - budget));
    }

    moveSteps.forEach((st, k) => push(st, k === 0 ? note : null));
  }

  // --- out ------------------------------------------------------------------
  push({ pose: { ...HOME, head_tilt: 40 }, eyes: { look: 0, speed: 40 }, ms: u }, '--- out ---');
  push({ pose: { head_tilt: 50 }, eyes: { fx: 'none', auto: true, blink: true, speed: 50, look: 0 }, light: true, ms: b });

  const seconds = total / 1000;
  return {
    id,
    label,
    bpm,
    /* The clip ends where the trim ends; the routine's closing step runs a
       beat or two past it in silence, which is what a walk-down should do. */
    audio: { file: audioFile, start: round1(audioStart), end: round1(audioStart + Math.min(seconds, features.duration)) },
    description: `Auto-choreographed from ${sourceName || 'an imported track'} — ${bars.length} bars at ${bpm} BPM, about ${Math.round(seconds)} seconds. Moves sized by loudness, lifted by pitch${holdHook ? ', with the hook step held from where it first lands to the end' : ''}.`,
    utterances: [label.toLowerCase(), `dance ${label.toLowerCase()}`, `play ${label.toLowerCase()}`],
    steps,
  };
}

const round1 = (v) => Math.round(v * 10) / 10;

/** "My Song (Remix)" -> "my_song_remix" — an id the server will accept. */
export function slug(text) {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return s || 'dance';
}

/** Mono Float32Array from a decoded AudioBuffer, channels averaged. */
export function monoOf(audioBuffer) {
  const n = audioBuffer.length;
  const out = new Float32Array(n);
  const ch = audioBuffer.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}
