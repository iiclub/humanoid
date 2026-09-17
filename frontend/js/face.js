/* ===========================================================================
 *  /face — the robot's talking head, in the phone browser.
 *
 *  Flow:
 *    tap to wake  ->  fullscreen  ->  listen  ->  /api/face/chat  ->  Ollama
 *                 ->  speak the reply  ->  listen again
 *
 *  Once awake the screen shows the eyes and one small ⛶ button (bottom-right,
 *  gone the moment fullscreen is on). Everything else lives on gestures:
 *
 *    tap                   wake / start listening
 *    ⛶ button              full screen — Chrome grants it only from a gesture,
 *                          and can refuse a tap that is also doing other work
 *    long-press (600 ms)   take a photo
 *    double-tap            show/hide the status overlay
 *    (mute)                say "stop listening" / "start listening"
 *
 *  Saying "take my picture" does the same as the long-press.
 *
 *  Everything here needs a SECURE CONTEXT. getUserMedia and
 *  webkitSpeechRecognition are both unavailable over plain http:// on a LAN
 *  address — the page detects that up front rather than failing silently.
 *
 *  No libraries, no CDN — same rule as the rest of this project.
 * ========================================================================= */

'use strict';

const $ = (sel) => document.querySelector(sel);

const el = {
  stage: $('#stage'), face: $('#face'), eyeL: $('#eyeL'), eyeR: $('#eyeR'),
  camera: $('#camera'), video: $('#video'), countdown: $('#countdown'),
  shutter: $('#shutter'), shot: $('#shot'), canvas: $('#canvas'),
  hud: $('#hud'), dot: $('#dot'), statusText: $('#statusText'), caption: $('#caption'),
};

const app = {
  awake: false,
  listening: false,      // recogniser is running
  agent: false,          // the control UI has switched the talking head on
  micEnabled: true,      // not muted by voice command
  busy: false,           // a chat round-trip or a photo is in flight
  speaking: false,
  recog: null,
  voice: null,
  stream: null,          // live camera MediaStream, held only while shooting
  wakeLock: null,
  lastSpoken: '',        // for echo suppression — see isEcho()
  echoTimer: null,
  lastActivity: Date.now(),
  micGranted: false,     // getUserMedia({audio}) has succeeded at least once
  eyes: null,            // last remote eye state from the control UI
  gazeHeld: false,       // control UI is aiming the eyes; idle wander stands down
  swingTimer: null,
  live: false,           // live dance owns the microphone; the recogniser stands down
  starting: false,       // a start() attempt is in the air (single-flight lock)
  startPending: false,   // start() called, waiting to see if onstart fires
  startTimer: null,
};

// ------------------------------------------------------------------ helpers

function setState(name) {
  el.face.className = 'face' + (name ? ' ' + name : '');
  // Thinking gets a half-lidded, unimpressed look.
  const droop = name === 'thinking';
  el.eyeL.classList.toggle('droop', droop);
  el.eyeR.classList.toggle('droop', droop);
}

function setStatus(text, cls) {
  el.statusText.textContent = text;
  el.dot.className = 'dot' + (cls ? ' ' + cls : '');
}

function say(heard, reply) {
  el.caption.innerHTML = '';
  if (heard) {
    const h = document.createElement('span');
    h.className = 'heard';
    h.textContent = '“' + heard + '”';
    el.caption.appendChild(h);
  }
  if (reply) el.caption.appendChild(document.createTextNode(reply));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* This page runs on a phone with no inspector attached and shows no text, so
   anything that goes wrong is otherwise invisible. Ship it to the server log. */
function report(level, msg) {
  try {
    fetch('/api/face/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, msg }),
      keepalive: true,
    }).catch(() => {});
  } catch (_) { /* never let logging break the page */ }
}

/** Anything that proves the machine is still turning over. */
function touch() { app.lastActivity = Date.now(); }

window.addEventListener('error', (e) => report('warn', `js error: ${e.message} @${e.lineno}`));
window.addEventListener('unhandledrejection', (e) =>
  report('warn', `unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`));

// ------------------------------------------------------------- live dance

/**
 * The Dance tab's 🎤 Live button, at this end.
 *
 * js/livedance.js is an ES module and this file is a classic script, so there
 * is no shared scope; the module publishes itself on window.liveDance and this
 * calls into it. What lives HERE is only the part that belongs to the face:
 * giving up the microphone and giving it back.
 */
async function setLive(on) {
  const api = window.liveDance;
  if (!api) { report('warn', 'live dance module not loaded'); return; }
  if (on === app.live) return;

  if (on) {
    app.live = true;
    stopRecognition();               // release the mic before asking for it again
    await wait(250);                 // stopping a recogniser is not instant
    setStatus('live dance', 'live');
    openEyes();
    const ok = await api.start({ onStatus: (t) => { touch(); setStatus(t, 'live'); } });
    if (!ok) {
      app.live = false;
      setStatus('live dance: no mic', 'bad');
      showHud(true);
      /* Tell the server it did not take, or the Dance tab sits there lit red
         claiming the robot is listening when it is not. */
      try { liveSocket()?.send(JSON.stringify({ type: 'live', on: false })); } catch (_) {}
      startRecognition();
    }
  } else {
    api.stop();
    app.live = false;
    setStatus('', '');
    setState('');
    touch();
    if (app.micEnabled && app.awake) startRecognition();
  }
  report('http', `live dance ${on ? 'started' : 'stopped'}`);
}

/**
 * The Head tab's voice-agent switch, at this end. On: start listening if the
 * page is awake (a page that is asleep starts when tapped, as before). Off:
 * stop, and stay stopped — startRecognition() refuses while the flag is down,
 * which is what keeps the watchdog from quietly re-arming it.
 */
function setAgent(on) {
  if (on === app.agent) return;
  app.agent = on;
  if (on) {
    if (app.awake && !app.live) { app.micEnabled = true; openEyes(); startRecognition(); }
    else if (!app.awake) setStatus('voice agent on — tap to wake', '');
  } else {
    stopRecognition();
    if (!app.live) { setStatus('voice agent off', ''); setState(''); }
  }
  report('http', `voice agent ${on ? 'on' : 'off'}`);
}

// -------------------------------------------------------------------- eyes

/**
 * Blink. The lids snap shut and reopen more slowly, which is what a real lid
 * does — a symmetric blink reads as a shutter.
 */
function blink(hold = 55) {
  el.eyeL.classList.add('blink');
  el.eyeR.classList.add('blink');
  setTimeout(() => {
    el.eyeL.classList.remove('blink');
    el.eyeR.classList.remove('blink');
  }, 80 + hold);
}

/* Randomised interval with the occasional double-blink. A fixed cadence reads
   as a loading spinner rather than a face.

   The Head tab can switch this off (eyes.blink === false) to hold the lids
   perfectly still — an unblinking stare. The loop keeps running either way, so
   turning it back on resumes immediately rather than waiting for a reload. */
function startBlinking() {
  const schedule = () => {
    setTimeout(() => {
      if (blinkEnabled()) {
        blink();
        if (Math.random() < 0.22) setTimeout(() => blink(35), 240);
      }
      schedule();
    }, 2200 + Math.random() * 4200);
  };
  schedule();
}

/** Default to blinking: a face that never blinks looks broken, not deliberate. */
function blinkEnabled() {
  return !app.eyes || app.eyes.blink !== false;
}

/**
 * Saccades. Eyes do not glide around; they fixate, then jump. So this holds a
 * position for a beat and then moves in one short step — with small drifts far
 * more common than large ones, and a blink accompanying the big jumps, which
 * is what happens when a real gaze crosses a wide angle.
 */
function startGaze() {
  const balls = document.querySelectorAll('.ball');

  const look = () => {
    /* Stand down while the control UI is aiming or swinging these eyes —
       otherwise the random walk fights it for the same transform. */
    if (app.gazeHeld) return setTimeout(look, 700);

    const big = Math.random() < 0.22;
    const range = big ? 8 : 3.2;
    const x = (Math.random() * 2 - 1) * range;
    const y = (Math.random() * 2 - 1) * range * 0.45;

    for (const b of balls) {
      b.style.transitionDuration = '';        // back to the stylesheet's saccade timing
      b.style.transform = `translate(${x}vmin, ${y}vmin)`;
    }
    if (big && Math.random() < 0.5 && blinkEnabled()) blink(30);

    // Fixations are short when alert, longer when idle.
    const hold = app.busy || app.speaking
      ? 420 + Math.random() * 500
      : 900 + Math.random() * 2200;
    setTimeout(look, hold);
  };
  look();
}

// --------------------------------------------------------------------- TTS

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  app.voice =
    voices.find((v) => /en-(GB|US|IN)/i.test(v.lang) && /male/i.test(v.name)) ||
    voices.find((v) => /en-GB/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    voices[0];
}

/**
 * Speak, and resolve when finished.
 *
 * The recogniser is stopped for the duration: an open microphone will happily
 * transcribe the robot's own voice and feed it back as a new question, which
 * becomes an infinite self-conversation within about three rounds.
 */
function speak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();

    stopRecognition();
    touch();
    app.speaking = true;
    setState('speaking');
    setStatus('speaking', 'busy');

    /* Remembered so isEcho() can recognise our own words coming back in.
       Cleared on a timer, or a genuine repeat of the question would be
       swallowed for the rest of the session. */
    app.lastSpoken = text;
    clearTimeout(app.echoTimer);
    app.echoTimer = setTimeout(() => { app.lastSpoken = ''; }, 12000);

    const utter = new SpeechSynthesisUtterance(text);
    if (app.voice) utter.voice = app.voice;
    utter.rate = 1.02;
    utter.pitch = 0.85;      // lowered a little — reads as "robot", not "assistant"
    utter.volume = 1;

    let done = false;
    let poll = null;

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      /* Settle before anyone re-opens the microphone. The audio tail and the
         phone's own speaker ring out past onend, and catching that is exactly
         how the robot ends up interviewing itself. */
      setTimeout(() => {
        app.speaking = false;
        touch();
        resolve();
      }, 350);
    };

    utter.onend = finish;
    utter.onerror = finish;

    /* onend is unreliable on Chrome for Android — it fires early, late, or not
       at all. The queue state is the honest signal, so poll that too, and only
       fall back to a timer as a last resort.

       This used to be a bare timer sized from the text length. When a reply
       took longer to speak than the estimate the mic re-armed mid-sentence and
       transcribed the rest of the robot's own voice as a new question. */
    speechSynthesis.cancel();
    speechSynthesis.speak(utter);

    setTimeout(() => {
      poll = setInterval(() => {
        if (!speechSynthesis.speaking && !speechSynthesis.pending) finish();
      }, 150);
    }, 250);           // give the queue a moment to actually start

    // Absolute ceiling, so a dropped utterance cannot wedge the loop forever.
    setTimeout(finish, Math.max(9000, text.length * 160));
  });
}

/* Second line of defence against self-conversation: even with the mic closed
   while speaking, a phone in a small room can catch the tail off a wall. If a
   transcript looks like what we just said, drop it. */
function isEcho(heard) {
  if (!app.lastSpoken) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const a = norm(heard);
  const b = norm(app.lastSpoken);
  if (!a || !b) return false;
  if (a.length > 8 && b.includes(a)) return true;

  const heardWords = a.split(' ');
  const spokenWords = new Set(b.split(' '));
  if (heardWords.length < 3) return false;
  const hits = heardWords.filter((w) => spokenWords.has(w)).length;
  return hits / heardWords.length >= 0.6;
}

// --------------------------------------------------------------------- STT

const PHOTO_PHRASES = [
  'take my picture', 'take my photo', 'take a picture', 'take a photo',
  'click my picture', 'click a picture', 'click my photo', 'take picture',
  'take photo', 'photo of me', 'picture of me', 'selfie', 'say cheese',
];
const MUTE_PHRASES = ['stop listening', 'go to sleep', 'be quiet', 'shut up'];
const UNMUTE_PHRASES = ['start listening', 'wake up', 'you can listen'];

const matches = (text, list) => {
  const t = text.toLowerCase();
  return list.some((p) => t.includes(p));
};

function buildRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;

  const recog = new Recognition();
  recog.lang = 'en-IN';
  recog.continuous = false;      // one utterance per start; we restart manually
  recog.interimResults = true;
  recog.maxAlternatives = 1;

  recog.onstart = () => {
    /* The microphone is genuinely open now. Nothing else in this file is
       allowed to claim that — an optimistic "listening" label was exactly what
       made a refused mic look like a working one. */
    app.listening = true;
    app.starting = false;
    app.startPending = false;
    clearTimeout(app.startTimer);
    touch();
    el.face.classList.remove('needs-tap');
    if (!app.busy && !app.speaking) {
      setState('listening');
      setStatus('listening', 'live');
    }
  };

  recog.onresult = (event) => {
    touch();
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += chunk;
      else interim += chunk;
    }
    if (interim && !app.busy) say(interim.trim(), '');
    if (final.trim()) handleUtterance(final.trim());
  };

  recog.onerror = (event) => {
    touch();
    app.starting = false;
    if (event.error !== 'no-speech' && event.error !== 'aborted') report('warn', `recognition error: ${event.error}`);
    if (event.error === 'network') {
      /* Chrome streams the audio to Google to transcribe it. No uplink on this
         WiFi means speech recognition cannot work at all, however strong the
         signal to the robot is. */
      needsTap('speech recognition needs internet — this WiFi has no uplink');
      showHud(true);
      say('', 'Speech recognition needs an internet connection. This WiFi appears to have none.');
    }
    // 'no-speech' and 'aborted' are routine; only real failures should surface.
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      app.micEnabled = false;
      setState('error');
      setStatus('microphone blocked', 'bad');
      showHud(true);
      say('', 'Microphone permission was denied. Allow it in the site settings and reload.');
      return;
    }
    if (event.error === 'audio-capture') {
      setState('error');
      setStatus('no microphone', 'bad');
    }
  };

  recog.onend = () => {
    app.listening = false;
    app.starting = false;
    touch();
    if (app.micEnabled && !app.busy && !app.speaking) {
      setTimeout(startRecognition, 260);
    }
  };

  return recog;
}

/**
 * Ask for the microphone.
 *
 * Chrome for Android only honours this when a user gesture is behind it. An
 * automatic restart after the first one is refused *silently* — no exception,
 * no error event, onstart simply never fires. So arm a timer: if the recogniser
 * has not actually started shortly after we asked, stop pretending and light
 * the talk button up for a real tap.
 */
/**
 * Open the microphone — the ONLY place that may call recog.start().
 *
 * Everything about Chrome's SpeechRecognition punishes concurrency. The talk
 * button, onend and the watchdog all want to restart listening, and when two of
 * them overlap the loser throws InvalidStateError, its abort() unsettles the
 * speech service, and the *next* attempt comes back `not-allowed` even though
 * the OS has granted the microphone. That is exactly the sequence the phone
 * logged:
 *
 *     recognition error: not-allowed
 *     start() threw InvalidStateError: recognition has already started
 *
 * So starts are single-flight: one attempt in the air at a time, and callers
 * that arrive during one are simply dropped rather than queued — whoever is
 * already starting is doing the same job.
 */
function startRecognition(fromGesture = false) {
  /* Live dance holds the microphone. Chrome for Android will hand the device
     to SpeechRecognition and getUserMedia at the same time and then deliver
     silence to one of them, so the two take turns rather than compete. */
  if (app.live) return;
  /* The voice agent is off until the Head tab turns it on. Nothing here may
     start the recogniser before that — not a tap, not the watchdog, not a
     "start listening" the phone happened to overhear. */
  if (!app.agent) return;
  if (!app.recog || app.listening || !app.micEnabled || app.busy || app.speaking) return;
  if (app.starting) return;              // single flight — a start is already in the air
  app.starting = true;

  const armWatchdog = () => {
    app.startPending = true;
    setStatus('opening mic', 'busy');
    clearTimeout(app.startTimer);
    app.startTimer = setTimeout(() => {
      app.starting = false;
      if (!app.startPending || app.listening) return;
      app.startPending = false;
      needsTap(fromGesture
        ? 'mic refused even after a tap'
        : 'mic refused without a gesture — tap the talk button');
    }, 1800);
  };

  try {
    app.recog.start();
    return armWatchdog();
  } catch (err) {
    /* InvalidStateError: the object still believes it is running because onend
       never fired, so every later start() throws and the mic is never opened
       again. It cannot be talked out of that — discard it and build a fresh
       one, but give the speech service a moment to settle first, or the new
       instance inherits the same `not-allowed`. */
    report('warn', `start() threw ${err.name}: ${err.message} — rebuilding recogniser`);
    try { app.recog.abort(); } catch (_) {}
    app.recog = null;

    setTimeout(() => {
      app.recog = buildRecognition();
      if (!app.recog) {
        app.starting = false;
        return needsTap('speech recognition unavailable in this browser');
      }
      try {
        app.recog.start();
        armWatchdog();
      } catch (err2) {
        app.starting = false;
        report('warn', `rebuilt recogniser also refused: ${err2.name}: ${err2.message}`);
        needsTap('mic will not open');
      }
    }, 600);
  }
}

/** The browser will not open the mic on its own; ask for a tap, visibly. */
function needsTap(why) {
  report('warn', why);
  /* There is no button and no text on screen, so the eyes themselves have to
     say "tap me": the irises pulse until a tap gets the microphone open. */
  el.face.classList.add('needs-tap');
  setStatus('tap to talk', 'bad');
}

function stopRecognition() {
  clearTimeout(app.startTimer);
  app.startPending = false;
  /* Release the single-flight lock too. Aborting during an in-flight start
     would otherwise strand it set forever, and startRecognition() would then
     refuse every future attempt — a deadlock indistinguishable from the dead
     microphone this whole mechanism exists to prevent. */
  app.starting = false;
  if (!app.recog) return;
  try { app.recog.abort(); } catch (_) { /* not running */ }
  app.listening = false;
}

// -------------------------------------------------------------------- brain

async function handleUtterance(text) {
  if (app.busy || app.speaking) return;

  if (isEcho(text)) {
    setStatus('ignored own voice', 'busy');
    return;                       // heard ourselves — say nothing back
  }

  if (matches(text, PHOTO_PHRASES)) {
    say(text, '');
    return takePhoto();
  }
  if (matches(text, MUTE_PHRASES)) {
    say(text, '');
    await speak('Fine. Ignoring you now.');
    setMic(false);
    return;
  }
  if (matches(text, UNMUTE_PHRASES) && !app.micEnabled) {
    setMic(true);
    return;
  }

  app.busy = true;
  touch();
  stopRecognition();
  setState('thinking');
  setStatus('thinking', 'busy');
  say(text, '');

  let reply = 'I am just born, let me first learn who that is.';
  try {
    const res = await fetch('/api/face/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const json = await res.json();
    if (json && json.reply) reply = json.reply;
  } catch (_) {
    /* Server unreachable — the newborn line above stands in. */
  }

  say(text, reply);
  await speak(reply);

  app.busy = false;
  touch();
  setState('');
  startRecognition();          // onstart sets the label, not us
}

function setMic(on) {
  app.micEnabled = on;
  setState('');

  if (on) {
    openEyes();
    startRecognition();        // onstart owns the "listening" label
  } else {
    stopRecognition();
    setStatus('muted', '');
    /* Half-lidded while muted, NOT shut. Fully closed lids are black on a black
       page, which is indistinguishable from a broken screen — the same reason
       the page no longer loads asleep. */
    el.eyeL.classList.add('droop');
    el.eyeR.classList.add('droop');
  }
}

// ------------------------------------------------------------------- camera

/**
 * Swap the eyes for the viewfinder, count down out loud, capture, post, and
 * swap back. The stream is opened per shot and stopped straight after, so the
 * phone's camera indicator is not lit the whole time the page is open.
 */
async function takePhoto() {
  if (app.busy) return;
  app.busy = true;
  stopRecognition();

  try {
    setStatus('camera', 'busy');
    await speak('Hold still. Trying to make you look good.');

    app.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });

    el.video.srcObject = app.stream;
    await el.video.play().catch(() => {});

    el.face.classList.add('hidden');
    el.camera.hidden = false;
    el.shot.hidden = true;
    await wait(320);           // let the sensor settle before the countdown

    for (const n of [3, 2, 1]) {
      el.countdown.textContent = String(n);
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(n));
      if (app.voice) u.voice = app.voice;
      u.rate = 1.1; u.pitch = 0.85;
      speechSynthesis.speak(u);
      await wait(800);
    }
    el.countdown.textContent = '';

    // --- capture ---
    const vw = el.video.videoWidth || 1280;
    const vh = el.video.videoHeight || 960;
    el.canvas.width = vw;
    el.canvas.height = vh;
    const ctx = el.canvas.getContext('2d');
    /* The preview is mirrored by CSS so framing feels like a mirror. The canvas
       draws the raw sensor frame, which is already un-mirrored — that is what
       we want in the file, since mirrored text reads backwards. */
    ctx.drawImage(el.video, 0, 0, vw, vh);
    const dataUrl = el.canvas.toDataURL('image/jpeg', 0.9);

    el.shutter.classList.add('flash');
    setTimeout(() => el.shutter.classList.remove('flash'), 400);

    el.shot.src = dataUrl;
    el.shot.hidden = false;

    // --- upload ---
    let saved = null;
    try {
      const res = await fetch('/api/face/photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      });
      const json = await res.json();
      if (json && json.ok) saved = json.file;
    } catch (_) {
      /* Saving is best-effort; the shot still showed on screen. */
    }

    await wait(1500);          // let them see the result

    stopCamera();
    el.camera.hidden = true;
    el.face.classList.remove('hidden');

    await speak(saved ? 'Got it. I will treasure this one, briefly.'
                      : 'Got it, though I could not save it anywhere.');
    say('', saved ? 'saved as ' + saved : 'photo taken (not saved)');
  } catch (err) {
    stopCamera();
    el.camera.hidden = true;
    el.face.classList.remove('hidden');
    setState('error');
    setStatus('camera blocked', 'bad');
    showHud(true);
    say('', 'Could not open the camera: ' + (err && err.message ? err.message : err));
    await speak('I cannot see anything. The camera said no.');
  }

  app.busy = false;
  touch();
  setState('');
  startRecognition();          // onstart owns the label
}

function stopCamera() {
  if (!app.stream) return;
  for (const track of app.stream.getTracks()) track.stop();
  app.stream = null;
  el.video.srcObject = null;
}

// ----------------------------------------------------------------- gestures

function showHud(on) {
  el.hud.hidden = !on;
}

/* No buttons on screen, so the two manual actions ride on gestures. Long-press
   wins over double-tap: if the finger is down past the threshold the tap
   counter is reset, so a press never also registers as a tap. */
/**
 * With no buttons left, the whole screen carries all three actions:
 *
 *   single tap   start / stop listening   (the user gesture Chrome demands)
 *   double tap   show / hide the status overlay
 *   long press   take a photo
 *
 * A single tap has to wait out the double-tap window before it fires, or every
 * double tap would also start the microphone on its way past. 300 ms is the
 * usual threshold and is short enough not to feel laggy.
 */
function wireGestures() {
  const DOUBLE_MS = 300;
  const LONG_MS = 600;

  let pressTimer = null;
  let tapTimer = null;
  let taps = 0;
  let longFired = false;

  const down = () => {
    longFired = false;
    pressTimer = setTimeout(() => {
      longFired = true;
      taps = 0;
      clearTimeout(tapTimer);
      if (!app.busy) takePhoto();
    }, LONG_MS);
  };

  const up = () => {
    clearTimeout(pressTimer);
    if (longFired) return;          // that was a press, not a tap

    /* Fullscreen is requested HERE, synchronously inside the pointer handler,
       and not from the tap timeout below.
       requestFullscreen() needs transient user activation, and pushing it
       behind even a 300 ms timer risks the browser having already discarded
       it — the request is then refused with no error worth reading. Everything
       else can wait for the double-tap window; this cannot. */
    goImmersive();

    taps++;
    clearTimeout(tapTimer);

    if (taps >= 2) {
      taps = 0;
      showHud(el.hud.hidden);       // second tap: the overlay, not the mic
      return;
    }

    tapTimer = setTimeout(() => {
      taps = 0;
      tapToTalk();                  // no second tap arrived — it was a single
    }, DOUBLE_MS);
  };

  el.stage.addEventListener('pointerdown', down);
  el.stage.addEventListener('pointerup', up);

  /* The fullscreen button sits inside the stage, so its events would bubble
     into the tap-to-talk handlers above and start the microphone. Swallow
     them here, then make the request directly from the click — that is the
     user gesture Chrome wants. */
  const full = document.getElementById('btnFull');
  if (full) {
    for (const ev of ['pointerdown', 'pointerup', 'pointercancel']) {
      full.addEventListener(ev, (e) => e.stopPropagation());
    }
    full.addEventListener('click', (e) => { e.stopPropagation(); goImmersive(); });
  }
  el.stage.addEventListener('pointercancel', () => clearTimeout(pressTimer));
  el.stage.addEventListener('contextmenu', (e) => e.preventDefault());
}

// --------------------------------------------------------------- fullscreen

/* Fullscreen and the wake lock both need the user gesture that opened them, so
   they are requested from inside the tap handler. Both are best-effort: the
   page works without either, it just shows the browser chrome and may dim. */
async function goImmersive() {
  try {
    // Already fullscreen, or launched from the home screen where there is no
    // browser chrome to escape in the first place.
    const standalone = window.matchMedia('(display-mode: fullscreen)').matches ||
                       window.matchMedia('(display-mode: standalone)').matches ||
                       window.navigator.standalone === true;
    const root = document.documentElement;
    const already = document.fullscreenElement || document.webkitFullscreenElement;

    if (!standalone && !already) {
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) await req.call(root, { navigationUI: 'hide' });
    }
  } catch (_) { /* refused — carry on windowed */ }

  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');   // the phone lies on its side in the head
    }
  } catch (_) { /* not permitted on most phones outside an installed PWA */ }

  await acquireWakeLock();
}

async function acquireWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    app.wakeLock = await navigator.wakeLock.request('screen');
    app.wakeLock.addEventListener('release', () => { app.wakeLock = null; });
  } catch (_) { /* denied or unsupported */ }
}

// --------------------------------------------------------------------- boot

/* Both the microphone and the camera need a secure context. Over plain http on
   a LAN address the APIs are simply absent, so check before the user has spent
   any time on the page. */
function preflight() {
  const problems = [];
  const secure = window.isSecureContext ||
                 location.protocol === 'https:' ||
                 ['localhost', '127.0.0.1'].includes(location.hostname);

  if (!secure) {
    problems.push(
      'This page is on http://, where phone browsers block the microphone and camera. ' +
      'Open it over https:// instead — see the README section on the face route.');
  }
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    problems.push('This browser has no speech recognition. Use Chrome on Android.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    problems.push('This browser will not give the page a camera.');
  }
  return problems;
}

/** Open the eyes fully, from either the shut or the half-lidded state. */
function openEyes() {
  el.face.classList.remove('asleep');
  for (const eye of [el.eyeL, el.eyeR]) {
    eye.classList.remove('shut');
    eye.classList.remove('droop');
  }
}

async function wake() {
  if (app.awake) return;
  app.awake = true;

  /* No text on screen, so a failed precondition has to show up somewhere else:
     the wake dot goes red and the debug overlay opens by itself. */
  const problems = preflight();
  if (problems.length) {
    el.face.classList.add('needs-tap');
    showHud(true);
    say('', problems.join(' '));
  }

  await goImmersive();

  openEyes();

  /* speechSynthesis has to be primed inside the tap handler or Chrome refuses
     to speak later. An empty utterance is enough to unlock it. */
  if ('speechSynthesis' in window) {
    speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  setStatus('waking up', 'busy');
  await speak('Oh good, another human. Ask me something.');

  app.recog = buildRecognition();
  if (!app.agent) {
    setStatus('awake · voice agent off', '');
  } else if (app.recog) {
    startRecognition(true);     // the tap that woke us is still the live gesture
  } else {
    setStatus('no microphone', 'bad');
    showHud(true);
    say('', 'Speech recognition is unavailable in this browser.');
  }
}

// ------------------------------------------------------- remote eye control

/**
 * The Head tab of the control UI can drive these eyes. It sends display state
 * to the server, the server mirrors it to every client, and this is the end of
 * that wire.
 *
 * Reconnects on its own: this page is meant to sit in a robot's head for hours,
 * and a dropped socket must not mean going to fetch the phone.
 */
let controlWs = null;
const liveSocket = () => (controlWs && controlWs.readyState === 1 ? controlWs : null);

function connectControl() {
  let ws;
  let retry = null;

  const open = () => {
    clearTimeout(retry);
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    } catch (_) {
      retry = setTimeout(open, 4000);
      return;
    }

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'hello') {
        if (msg.state && msg.state.eyes) applyEyes(msg.state.eyes);
        setAgent(!!msg.voiceAgent);
        if (msg.live) setLive(true);           // a dance was already running when we joined
      } else if (msg.type === 'eyes') applyEyes(msg.eyes);
      else if (msg.type === 'live') setLive(!!msg.on);
      else if (msg.type === 'voiceagent') setAgent(!!msg.on);
    };

    controlWs = ws;
    ws.onclose = () => { controlWs = null; retry = setTimeout(open, 4000); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  };

  open();
}

/**
 * Speed 1..100 -> milliseconds. Fast means a short duration, hence the flip.
 *
 * The slow ends are deliberately extreme. A lid that closes in 900 ms still
 * reads as a blink; to look like a machine powering down it has to take
 * seconds, so speed 1 is now 4 s of lid travel and a 14 s swing. The fast ends
 * are unchanged — 1 was the useless end of the dial, not 100.
 *
 * backend/src/sequence.js inverts the lid range to time the wake sequence, so
 * these two numbers are mirrored there.
 */
const speedMs = (speed, slowest, fastest) =>
  slowest - ((Math.max(1, Math.min(100, speed)) - 1) / 99) * (slowest - fastest);

const LID_MS = (speed) => speedMs(speed, 4000, 70);       // was 900 at the slow end
const SWING_MS = (speed) => speedMs(speed, 14000, 700);   // was 5200
const AIM_MS = (speed) => speedMs(speed, 3500, 90);       // was 1100

/**
 * Apply a remote eye state.
 *
 * `look` is a percentage, not a distance: -100 is as far left as the eyeball
 * can travel inside its aperture without showing an edge. With the narrow
 * fierce aperture that limit is 1.8vmin — see the .ball sizing note in
 * face.css. A hard stare barely moves anyway; a wide-roving eye reads as
 * friendly, which is not what this face is for.
 */
const GAZE_RANGE = 11;

function applyEyes(eyes) {
  if (!eyes) return;
  app.eyes = eyes;

  /* DJ mode, driven by the dance routines and by the Dance tab.
     The class goes on <body>: setState() rebuilds .face's className outright,
     so anything left there would be wiped the first time somebody spoke to the
     robot mid-dance. Every DJ animation in face.css is written in multiples of
     --beat-ms, so setting the one variable retimes the lot. */
  document.body.classList.toggle('dj', eyes.fx === 'dj');
  if (eyes.bpm) {
    document.documentElement.style.setProperty(
      '--beat-ms', `${Math.round(60000 / Math.max(40, Math.min(200, eyes.bpm)))}ms`);
  }

  /* Switching blinking off mid-blink would leave the lids down until the
     next one, so clear any blink in flight. */
  if (eyes.blink === false) {
    el.eyeL.classList.remove('blink');
    el.eyeR.classList.remove('blink');
  }

  // Lids: reuse the same .shut class the mute state uses.
  const shut = eyes.lids === 'closed';
  for (const eye of [el.eyeL, el.eyeR]) {
    eye.style.setProperty('--lid-ms', `${Math.round(LID_MS(eyes.speed))}ms`);
    eye.classList.toggle('shut', shut);
  }

  // Manual aim and swing both take the eyes off their idle wander.
  app.gazeHeld = !eyes.auto || eyes.swing;

  clearInterval(app.swingTimer);
  app.swingTimer = null;

  if (eyes.swing) {
    /* A sine sweep rather than ping-pong between the extremes: the ends have
       to decelerate, or it reads as a metronome instead of a look. */
    const period = SWING_MS(eyes.speed);
    const started = Date.now();
    app.swingTimer = setInterval(() => {
      const phase = ((Date.now() - started) % period) / period;
      aimEyes(Math.sin(phase * Math.PI * 2) * 100, 90);
    }, 60);
  } else if (app.gazeHeld) {
    aimEyes(eyes.look, AIM_MS(eyes.speed));
  }
}

/** Point both eyeballs. look: -100..100, ms: how long to take getting there. */
function aimEyes(look, ms) {
  const x = (Math.max(-100, Math.min(100, look)) / 100) * GAZE_RANGE;
  for (const b of document.querySelectorAll('.ball')) {
    b.style.transitionDuration = `${Math.round(ms)}ms`;
    b.style.transform = `translate(${x.toFixed(2)}vmin, 0)`;
  }
}

/* The eyes are alive from page load — blinking, looking around, gestures armed.
   None of that needs a permission or a user gesture, and holding it back was
   what made the page look blank before the first tap. Only audio, the
   microphone and fullscreen wait for wake(). */
startBlinking();
startGaze();
wireGestures();
connectControl();

/**
 * Watchdog.
 *
 * Both failure modes here are silent and look identical from the outside: the
 * status label freezes on whatever it last said and the robot simply stops
 * answering.
 *
 *   1. `speaking` or `busy` sticks true. Chrome for Android's speechSynthesis
 *      can leave the queue wedged after a cancel(), so the promise never
 *      settles. handleUtterance() then drops every utterance on its first line.
 *   2. The recogniser dies without firing onend, so nothing ever re-arms it.
 *
 * Neither is worth chasing engine by engine — an unattended robot face has to
 * come back on its own, so just detect the stall and restart.
 */
setInterval(() => {
  if (!app.awake) return;
  const idle = Date.now() - app.lastActivity;

  if (app.live) { touch(); return; }        // the dance is the activity

  if ((app.busy || app.speaking) && idle > 20000) {
    report('warn', `wedged ${Math.round(idle / 1000)}s (busy=${app.busy} speaking=${app.speaking}) — resetting`);
    app.busy = false;
    app.speaking = false;
    try { speechSynthesis.cancel(); } catch (_) {}
    touch();
    setState('');
    startRecognition();        // onstart owns the label; it may need a tap
    return;
  }

  if (app.micEnabled && !app.live && !app.busy && !app.speaking && !app.listening && !app.starting && idle > 8000) {
    report('warn', `recogniser stopped ${Math.round(idle / 1000)}s ago — restarting`);
    touch();
    startRecognition();
  }
}, 4000);

/* --- the two dots ------------------------------------------------------- */

/**
 * One tap anywhere = start talking.
 *
 * Chrome for Android will not open the microphone without a user gesture
 * behind the request, and it refuses automatic restarts silently. With no
 * button left on screen, the tap target is the screen.
 */
async function tapToTalk() {
  touch();

  if (!app.awake) return wake();
  if (app.busy || app.speaking) return;      // mid-answer; let it finish

  if (!app.agent) {                           // a tap wakes and goes fullscreen, nothing more
    setStatus('voice agent off — Head tab turns it on', '');
    return;
  }

  if (app.listening) {                        // tapping again stops it
    app.micEnabled = false;
    stopRecognition();
    setStatus('stopped', '');
    el.eyeL.classList.add('droop');
    el.eyeR.classList.add('droop');
    return;
  }

  app.micEnabled = true;
  openEyes();

  /* Ask for the microphone directly, once, before handing over to the
     recogniser. The camera flow only ever requested { video: true }, so audio
     permission may never have been granted for this origin — and
     SpeechRecognition's own prompt gives us nothing catchable when refused.
     getUserMedia does. The tracks are stopped immediately; this is a
     permission check, not a recording. */
  if (!app.micGranted && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    setStatus('asking for mic', 'busy');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of stream.getTracks()) t.stop();
      app.micGranted = true;
      report('http', 'microphone permission granted');
      /* Stopping a track does not hand the microphone back instantly. Starting
         SpeechRecognition in the same tick means competing with ourselves for
         the device, and Chrome answers that with `not-allowed`. */
      await wait(500);
    } catch (err) {
      report('warn', `microphone permission failed: ${err.name}: ${err.message}`);
      needsTap(`mic permission: ${err.name}`);
      return;
    }
  }

  startRecognition(true);       // true: a genuine gesture is behind this one
}

/* Leaving the tab must not leave the camera on or the recogniser running. The
   wake lock is dropped by the browser automatically and has to be retaken. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopRecognition();
    stopCamera();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  } else if (app.awake) {
    acquireWakeLock();
    if (app.micEnabled && !app.busy) startRecognition();
  }
});

window.addEventListener('pagehide', () => { stopCamera(); stopRecognition(); });
