'use strict';

/**
 * Voice control: spoken phrase -> action id.
 *
 * Two hops, both on this machine:
 *
 *   1. audio  -> text        tools/stt-server.py (faster-whisper) on :8123
 *   2. text   -> action id   Ollama on :11434
 *
 * Neither hop touches the internet, which matters for a robot that is meant to
 * work on a bench with no uplink — and it keeps a live microphone feed off
 * third-party servers.
 *
 * The model is asked to pick from a fixed catalogue rather than to invent
 * joint angles. A 1.5B model is perfectly capable of "give me a handshake" ->
 * `handshake`, and is not capable of safe inverse kinematics; letting it emit
 * an id keeps every motion inside gestures that were written and tested by
 * hand. It is also why an unrecognised phrase does nothing at all instead of
 * moving the arms somewhere approximate.
 */

const http = require('http');
const { URL } = require('url');

const DEFAULTS = {
  sttUrl: process.env.STT_URL || 'http://127.0.0.1:8123',
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  model: process.env.OLLAMA_MODEL || 'qwen2.5:1.5b',
  timeoutMs: Number(process.env.VOICE_TIMEOUT_MS) || 20000,
};

/**
 * Built on `http` rather than `fetch` on purpose: global fetch only exists from
 * Node 18, and this project is happy to run on whatever Node a robot builder
 * already has. Same reason there is no AbortController here — the timeout is
 * the socket's own, which Node has always had.
 *
 * Resolves to { ok, status, body } with the body as a Buffer; rejects only on
 * transport failure, so an HTTP 500 is something the caller inspects rather
 * than catches.
 */
function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body: buf,
            json: () => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } },
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* Words that carry no evidence about which gesture was meant. Without this,
   "what is the capital of France" scores against `light_on` purely because both
   contain "the", and a robot waves its arms at a trivia question. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'out', 'are', 'was', 'its',
  'can', 'could', 'would', 'will', 'should', 'please', 'some', 'very', 'quite',
  'actually', 'really', 'think', 'need', 'about', 'there', 'here', 'what',
  'when', 'where', 'how', 'why', 'did', 'does', 'have', 'has', 'had', 'from',
  'they', 'them', 'our', 'but', 'not', 'you', 'your', 'yourself', 'like',
  'just', 'now', 'then', 'into', 'over', 'give', 'get', 'let', 'make', 'want',
]);

/** The threshold a phrase must clear to be treated as evidence for an action. */
const MIN_SCORE = 25;

class Voice {
  constructor({ actions, log, config = {} } = {}) {
    this.actions = actions;
    this.log = log || (() => {});
    this.cfg = { ...DEFAULTS, ...config };
  }

  /** Are the two local services actually up? Drives the UI's status dot. */
  async health() {
    const probe = async (url, label) => {
      try {
        const res = await request(url, { timeoutMs: 2500 });
        return { ok: res.ok, detail: res.ok ? 'ready' : `HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, detail: err.code === 'ETIMEDOUT' ? 'timed out' : `${label} not reachable` };
      }
    };

    const [stt, ollama] = await Promise.all([
      probe(`${this.cfg.sttUrl}/health`, 'stt-server'),
      probe(`${this.cfg.ollamaUrl}/api/tags`, 'ollama'),
    ]);
    return { stt, ollama, model: this.cfg.model };
  }

  // ------------------------------------------------------------------ stt --

  async transcribe(audioBuffer) {
    if (!audioBuffer || !audioBuffer.length) throw new Error('no audio received');

    let res;
    try {
      res = await request(`${this.cfg.sttUrl}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': audioBuffer.length },
        body: audioBuffer,
      });
    } catch (err) {
      throw new Error(
        err.code === 'ETIMEDOUT'
          ? 'the speech-to-text server timed out'
          : 'the speech-to-text server is not running — start it with  npm run stt',
      );
    }

    const data = res.json() || {};
    if (!res.ok || !data.ok) throw new Error(data.error || `speech-to-text failed (HTTP ${res.status})`);
    return { text: (data.text || '').trim(), ms: data.ms };
  }

  // --------------------------------------------------------------- intent --

  /**
   * Offline matcher, used when Ollama is unreachable and as a sanity check on
   * what it returns. Scores each action against the utterance list: an exact
   * phrase hit beats a bag-of-words overlap, which beats nothing.
   */
  /** How strongly one phrase supports one action. 0 means "no lexical basis". */
  score(text, action) {
    const said = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!said) return 0;
    const saidWords = said.split(' ');
    const saidSet = new Set(saidWords);
    /* Long utterances are conversation; short ones are commands. This matters
       for one-word triggers like "point" or "wave", which otherwise fire on any
       sentence that happens to contain them — "I need to point out that…" was a
       pointing gesture before this existed. */
    const terse = saidWords.length <= 4;

    const phrases = [action.label || '', ...(action.utterances || [])]
      .map((p) => p.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    let score = 0;
    for (const phrase of phrases) {
      const words = phrase.split(' ').filter(Boolean);
      const multi = words.length > 1;

      if (said === phrase) { score = Math.max(score, 100); continue; }
      if ((multi || terse) && said.includes(phrase)) { score = Math.max(score, 60 + phrase.length); continue; }
      if (!multi && !terse) continue;             // a bare word inside a sentence proves nothing

      const meaty = words.filter((w) => w.length > 2 && !STOPWORDS.has(w));
      if (!meaty.length) continue;
      const hits = meaty.filter((w) => saidSet.has(w)).length;
      if (hits) score = Math.max(score, (hits / meaty.length) * 40);
    }
    return score;
  }

  keywordMatch(text, minScore = MIN_SCORE) {
    let best = null;
    for (const action of this.actions.catalogue) {
      const score = this.score(text, action);
      if (score > 0 && (!best || score > best.score)) best = { id: action.id, score };
    }

    // Below the threshold the "match" is one incidental word, and acting on it
    // would be worse than admitting we did not understand.
    return best && best.score >= minScore ? best : null;
  }

  async askOllama(text) {
    const catalogue = this.actions.catalogue;
    const list = catalogue
      .map((a) => `- ${a.id}: ${a.description} (e.g. "${(a.utterances || [])[0] || a.label}")`)
      .join('\n');

    /* Two things here are load-bearing, both learned the hard way from this
       model actuating a robot on the strength of a trivia question.

       `none` is offered as a real choice rather than asking for null. Forced
       JSON decoding means the model must emit *something*, and a small model
       handed a list of 18 actions and no way to decline will pick the least
       bad one — "what is the capital of France" came back as `light_on`.
       Giving refusal its own id turns declining into a normal answer.

       The few-shot turns then show it being used. Describing the rule in prose
       was not enough; demonstrating it is. */
    const system =
      'You map what someone said to a humanoid robot onto exactly one action id.\n\n' +
      `Actions:\n${list}\n- none: the speech is not a command for the robot, or matches no action above\n\n` +
      'Reply with ONLY {"action":"<id>","confidence":<0-1>}.\n' +
      'Use an id verbatim from the list. Never invent an id.\n\n' +
      'Choose an action ONLY when the speech is an instruction addressed to the robot — ' +
      'something it is being told to do right now.\n' +
      'Choose "none" for questions, opinions, small talk and background chatter. ' +
      'In particular, merely MENTIONING a light, a hand, dancing or pointing is not an instruction: ' +
      '"turn on the light" is a command, "the light in here is nice" is not; ' +
      '"point at it" is a command, "I should point out that..." is not.\n' +
      'Prefer "none" over a loose guess: a wrong action moves a physical machine, refusing does nothing.';

    /* Half of these demonstrate refusal, and the last two are the specific trap
       this model kept falling into — a sentence that names the subject of an
       action without asking for it. */
    const shots = [
      ['give me a handshake', 'handshake'],
      ['what is the capital of France', 'none'],
      ['put your hands up', 'hands_up'],
      ['how are you doing today', 'none'],
      ['say hello', 'wave'],
      ['the light in this room is nice actually', 'none'],
      ['turn off the light', 'light_off'],
      ['i need to point out that this is wrong', 'none'],
    ];

    const payload = Buffer.from(JSON.stringify({
      model: this.cfg.model,
      stream: false,
      format: 'json',             // Ollama constrains decoding to valid JSON
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: system },
        ...shots.flatMap(([said, action]) => [
          { role: 'user', content: said },
          { role: 'assistant', content: JSON.stringify({ action, confidence: action === 'none' ? 0 : 0.95 }) },
        ]),
        { role: 'user', content: String(text) },
      ],
    }));

    const res = await request(`${this.cfg.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      body: payload,
    });

    if (!res.ok) throw new Error(`ollama returned HTTP ${res.status}`);
    const data = res.json();
    const raw = data?.message?.content || '';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`ollama did not return JSON: ${raw.slice(0, 120)}`);
    }

    const id = parsed.action;
    if (!id || id === 'none') return null;          // an explicit, deliberate refusal
    // Never trust the id blindly — a hallucinated one must not reach run().
    if (!catalogue.some((a) => a.id === id)) throw new Error(`ollama picked unknown action "${id}"`);
    return { id, confidence: Number(parsed.confidence) || 0 };
  }

  /**
   * Resolve a phrase to an action. Ollama first; the keyword matcher both
   * covers it being down and rescues the case where a small model returns null
   * for something the utterance list plainly contains.
   */
  async resolve(text) {
    const said = String(text || '').trim();
    if (!said) return { action: null, via: 'empty', text: said };

    let viaModel = null;
    let modelError = null;
    try {
      viaModel = await this.askOllama(said);
    } catch (err) {
      modelError = err.message;
      this.log('warn', `ollama: ${err.message}`);
    }

    /* Grounding gate.

       A 1.5B model under forced-JSON decoding will always name an action, and
       it is wrong often enough to matter: "what is the capital of France" came
       back as `light_on` even with that exact sentence in the few-shot. So the
       model does not get the final say on *whether* the robot moves — only on
       *which* gesture, among ones the words actually support.

       The cost is real and worth stating: a command that shares no vocabulary
       with its action ("I'm nervous" -> hands_up) is refused rather than
       guessed at. Widening what a phrase can reach is a matter of adding
       utterances in actions.json, which is a safer knob than trusting a small
       model's imagination. */
    if (viaModel) {
      const meta = this.actions.catalogue.find((a) => a.id === viaModel.id);
      const grounding = this.score(said, meta);
      if (grounding >= MIN_SCORE) {
        return { action: viaModel.id, confidence: viaModel.confidence, via: 'ollama', text: said };
      }
      this.log('warn', `ollama picked "${viaModel.id}" for "${said}" with no wording to support it — ignored`);
      return {
        action: null,
        via: 'rejected — no wording matched',
        text: said,
        note: `the model suggested "${viaModel.id}" but nothing in the phrase supports it`,
      };
    }

    /* Two very different situations land here, and they deserve different
       levels of trust in the keyword matcher:

         Ollama is down    keywords are all we have, so accept a normal match.
         Ollama said none  it read the phrase and declined. Only override that
                           on a near-exact hit — otherwise "I need to point out
                           that…" becomes a pointing gesture. */
    const fallback = this.keywordMatch(said, modelError ? 25 : 60);
    if (fallback) {
      return {
        action: fallback.id,
        confidence: Math.min(1, fallback.score / 100),
        via: modelError ? 'keywords (ollama unavailable)' : 'keywords',
        text: said,
        note: modelError || undefined,
      };
    }

    return { action: null, via: modelError ? 'ollama unavailable' : 'no match', text: said, note: modelError || undefined };
  }
}

module.exports = { Voice, DEFAULTS };
