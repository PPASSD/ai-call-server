require('dotenv').config();

/* ========================
   GLOBAL DEBUG
======================== */
process.on('uncaughtException', e => console.error('🔥 UNCAUGHT EXCEPTION', e));
process.on('unhandledRejection', e => console.error('🔥 UNHANDLED PROMISE', e));

const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const { spawn } = require('child_process');

const app = express();
const port = process.env.PORT || 10000;

/* ========================
   ENV
======================== */
const {
  PUBLIC_HOST,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  DG_API_KEY,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  ELEVENLABS_KEY,
  ELEVENLABS_VOICE
} = process.env;

console.log('🚀 SERVER BOOTING');
console.log('🌐 PUBLIC_HOST:', PUBLIC_HOST);
console.log('🤖 GEMINI_MODEL:', GEMINI_MODEL);

/* ========================
   STATE
======================== */
const memory = {};

/* ========================
   EXPRESS + PARSERS
======================== */
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/* ========================
   LOGGING
======================== */
const log = (flag, ...args) => console.log(`[${flag}]`, ...args);

/* ========================
   HEALTH CHECK
======================== */
app.get('/', (_, res) => res.send('✅ AI Call Server Alive'));
app.get('/health', (_, res) => res.json({ ok: true, timestamp: Date.now() }));

/* ========================
   TWILIO WEBHOOK
======================== */
app.post('/twilio-voice-webhook', (req, res) => {
  const callSid = req.body.CallSid;
  log('TWILIO', 'Incoming call', callSid);

  memory[callSid] = [];
  const wsUrl = `wss://${PUBLIC_HOST}/stream?callSid=${callSid}`;

  res.type('text/xml').send(`
<Response>
  <Say voice="alice">
    Hi, please hold while I connect you.
  </Say>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
  <!-- Keep call alive -->
  <Pause length="600" />
</Response>
`);
});

// Optional GET to prevent browser "Cannot GET" noise
app.get('/twilio-voice-webhook', (_, res) => res.send('Twilio webhook expects POST'));

/* ========================
   OUTBOUND CALL (OPTIONAL)
======================== */
app.post('/start-call', async (req, res) => {
  log('TWILIO', 'Start call payload', req.body);

  try {
    const result = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
      new URLSearchParams({
        To: req.body.phone,
        From: TWILIO_NUMBER,
        Url: `https://${PUBLIC_HOST}/twilio-voice-webhook`
      }),
      { auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN } }
    );

    log('TWILIO', 'Outbound call SID', result.data.sid);
    res.json({ ok: true });
  } catch (e) {
    console.error('🔥 CALL FAILED', e.response?.data || e.message);
    res.status(500).send('fail');
  }
});

/* ========================
   SERVER + WS
======================== */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.pathname !== '/stream') {
    log('WS', 'Rejected upgrade', url.pathname);
    return socket.destroy();
  }

  wss.handleUpgrade(req, socket, head, ws => {
    ws.callSid = url.searchParams.get('callSid');
    log('WS', 'Upgrade OK', ws.callSid);
    wss.emit('connection', ws);
  });
});

/* ========================
   GEMINI
======================== */
async function callGemini(text) {
  log('GEMINI', 'Prompt:', text);
  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`,
      { contents: [{ role: 'user', parts: [{ text }] }] },
      { params: { key: GEMINI_API_KEY } }
    );
    const reply = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    log('GEMINI', 'Reply:', reply);
    return reply;
  } catch (e) {
    console.error('🔥 GEMINI ERROR', e.response?.data || e.message);
    return null;
  }
}

/* ========================
   ELEVENLABS TTS
======================== */
async function tts(text) {
  log('TTS', 'Generating speech');
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
    { text },
    { headers: { 'xi-api-key': ELEVENLABS_KEY }, responseType: 'arraybuffer' }
  );
  return Buffer.from(r.data);
}

/* ========================
   AUDIO CONVERSION
======================== */
function convert(buffer) {
  return new Promise(resolve => {
    const ff = spawn('ffmpeg', ['-i', 'pipe:0', '-f', 'mulaw', '-ar', '8000', '-ac', '1', 'pipe:1']);
    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));
    ff.on('close', () => resolve(Buffer.concat(chunks).toString('base64')));
    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

/* ========================
   WS HANDLER
======================== */
wss.on('connection', ws => {
  const callSid = ws.callSid;
  log('WS', 'Connected', callSid);

  const dg = new WebSocket(
    'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000',
    { headers: { Authorization: `Token ${DG_API_KEY}` } }
  );

  dg.on('open', () => log('DEEPGRAM', 'Connected'));
  dg.on('error', e => console.error('🔥 DEEPGRAM ERROR', e));

  // Keepalive to Deepgram
  const keepAlive = setInterval(() => {
    if (dg.readyState === WebSocket.OPEN) {
      dg.send(JSON.stringify({ type: 'KeepAlive' }));
    }
  }, 5000);

  dg.on('message', async msg => {
    const data = JSON.parse(msg.toString());
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript) return;

    log('DEEPGRAM', 'Transcript:', transcript);

    // Non-blocking AI
    (async () => {
      const reply = await callGemini(transcript);
      if (!reply) return;

      const audio = await convert(await tts(reply));
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'media', media: { payload: audio } }));
        log('AUDIO', 'Reply sent');
      }
    })();
  });

  ws.on('message', msg => {
    const data = JSON.parse(msg.toString());
    log('TWILIO', 'Event:', data.event);

    if (data.event === 'start') {
      log('TWILIO', 'Stream started', data.start.callSid);

      // 🔥 IMMEDIATE GREETING
      (async () => {
        const greeting = 'Hi, this is the pool assistant. How can I help you today?';
        const audio = await convert(await tts(greeting));
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'media', media: { payload: audio } }));
          log('AUDIO', 'Initial greeting sent');
        }
      })();
      return;
    }

    if (data.event === 'media' && dg.readyState === WebSocket.OPEN) {
      dg.send(Buffer.from(data.media.payload, 'base64'));
    }
  });

  ws.on('close', () => {
    log('WS', 'Closed', callSid);
    clearInterval(keepAlive);
    dg.close();
  });

  ws.on('error', e => console.error('🔥 WS ERROR', e));
});

/* ========================
   START SERVER
======================== */
server.listen(port, () => console.log(`✅ Server listening on port ${port}`));
