'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

/**
 * The /face route's server side: a talking head for the robot.
 *
 * Two endpoints, both used only by frontend/js/face.js:
 *
 *   POST /api/face/chat    { text }   -> { reply, source }
 *   POST /api/face/photo   { image }  -> { file, bytes }
 *
 * The chat endpoint proxies to Ollama on this machine. It is deliberately a
 * proxy rather than a direct browser->Ollama call: Ollama listens on
 * 127.0.0.1 only, the phone is a different host, and opening it to the LAN
 * just to serve one page would be a worse trade than forwarding here.
 *
 * Node 14 has no global fetch and this project has no HTTP client dependency,
 * so the call is plain http.request.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT) || 11434;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';

/* Ollama has to load the model on the first request, which can take a few
   seconds on a cold start. Anything past this and we would rather say the
   fallback line than leave somebody standing in front of a silent robot. */
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 20000;

/* The demo line. Also the fallback whenever the model cannot be reached, so a
   dead Ollama degrades to "charmingly newborn" instead of "broken". */
const NEWBORN_LINE = 'I am just born, let me first learn who that is.';

/* Sarcastic, but short — every reply gets read aloud by the browser's speech
   synthesiser, and anything longer than a couple of sentences is a monologue
   nobody wants to stand through. */
const SYSTEM_PROMPT = [
  'You are the voice of a small homemade humanoid robot, freshly assembled on a workbench.',
  'Your personality is dry, sarcastic and deadpan — think a bored robot who has seen it all,',
  'despite having existed for about four minutes.',
  '',
  'Rules you never break:',
  '- Reply in at most two short sentences. You are being read aloud; be brief.',
  '- Be sarcastic and witty, never cruel, never insulting about the person.',
  '- Plain speech only: no emoji, no asterisks, no stage directions, no markdown.',
  '- Never mention that you are an AI or a language model. You are a robot.',
  '- If you genuinely do not know something, say so sarcastically rather than inventing facts.',
].join('\n');

/** Ask Ollama. Resolves to the reply text, or rejects — the caller falls back. */
function askOllama(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      options: {
        temperature: 0.8,       // sarcasm needs a little room to move
        num_predict: 80,        // hard ceiling on length, so TTS stays short
      },
    });

    const req = http.request({
      host: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: OLLAMA_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`ollama returned ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(body);
          const reply = (json.message && json.message.content || '').trim();
          if (!reply) return reject(new Error('ollama returned an empty reply'));
          resolve(reply);
        } catch (err) {
          reject(new Error(`could not parse ollama response: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error(`ollama did not answer in ${OLLAMA_TIMEOUT_MS} ms`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/* Speech recognition hands us raw dictation: no punctuation to speak of, wildly
   inconsistent casing, and the occasional 30-second ramble when it fails to
   detect a pause. Trim it before it reaches the model. */
function cleanTranscript(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Strip the things a small model sprinkles in that sound wrong when spoken. */
function tidyForSpeech(reply) {
  return reply
    .replace(/\*+/g, '')                       // markdown emphasis
    .replace(/^\s*[-•]\s*/gm, '')              // stray bullets
    .replace(/\((?:laughs|sighs|beep)[^)]*\)/gi, '')  // stage directions
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function buildFaceApi({ log = () => {} } = {}) {
  const router = express.Router();

  /* Photos are written next to the config, not inside frontend/, so they are
     never accidentally served to the network. */
  const captureDir = path.resolve(__dirname, '..', '..', 'captures');

  router.get('/status', async (_req, res) => {
    res.json({
      ok: true,
      model: OLLAMA_MODEL,
      ollama: `${OLLAMA_HOST}:${OLLAMA_PORT}`,
      fallback: NEWBORN_LINE,
    });
  });

  /** { text } -> { reply, source: 'ollama' | 'fallback' } */
  router.post('/chat', async (req, res) => {
    const text = cleanTranscript(req.body && req.body.text);
    if (!text) return res.status(400).json({ ok: false, error: 'no text' });

    log('http', `face: heard "${text}"`);

    try {
      const reply = tidyForSpeech(await askOllama(text));
      log('http', `face: said  "${reply}"`);
      return res.json({ ok: true, reply, source: 'ollama' });
    } catch (err) {
      // Never fail the request — a silent robot reads as a crash to the person
      // standing in front of it. Speak the newborn line instead.
      log('warn', `face: ollama unavailable (${err.message}) — using fallback line`);
      return res.json({ ok: true, reply: NEWBORN_LINE, source: 'fallback' });
    }
  });

  /**
   * { level, msg } — the phone's console, relayed here.
   *
   * The face route runs on a device with no inspector attached, and it has no
   * text on screen by design, so a wedged state is otherwise invisible. This
   * puts the browser's own account of what happened into the server log next
   * to the requests it did or did not make.
   */
  router.post('/log', (req, res) => {
    const { level, msg } = req.body || {};
    const line = String(msg || '').slice(0, 300);
    if (line) log(level === 'warn' ? 'warn' : 'http', `face[phone]: ${line}`);
    res.json({ ok: true });
  });

  /** { image: "data:image/jpeg;base64,…" } -> { file } */
  router.post('/photo', (req, res) => {
    const data = String((req.body && req.body.image) || '');
    const match = /^data:image\/(jpeg|png);base64,(.+)$/.exec(data);
    if (!match) return res.status(400).json({ ok: false, error: 'expected a base64 jpeg or png data URL' });

    const buf = Buffer.from(match[2], 'base64');
    if (!buf.length) return res.status(400).json({ ok: false, error: 'empty image' });

    try {
      fs.mkdirSync(captureDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const file = path.join(captureDir, `face_${stamp}.${match[1] === 'png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(file, buf);
      log('http', `face: saved photo ${path.basename(file)} (${Math.round(buf.length / 1024)} kB)`);
      return res.json({ ok: true, file: path.basename(file), bytes: buf.length });
    } catch (err) {
      log('warn', `face: could not save photo — ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { buildFaceApi, NEWBORN_LINE, OLLAMA_MODEL };
