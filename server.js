require('dotenv').config();
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
  ELEVENLABS_VOICE,
  DEBUG_TWILIO,
  DEBUG_WS,
  DEBUG_DEEPGRAM,
  DEBUG_GEMINI,
  DEBUG_TTS,
  DEBUG_AUDIO
} = process.env;

console.log('🚀 BOOT');
console.log('Public Host:', PUBLIC_HOST);
console.log('Gemini Model:', GEMINI_MODEL);

/* ========================
   STATE
======================== */
const memory = {};

/* ========================
   EXPRESS
======================== */
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/* ========================
   UTILS
======================== */
const log = (flag, ...args) => {
  if (flag === 'ALL' || process.env[`DEBUG_${flag}`] === 'true') {
    console.log(`[${flag}]`, ...args);
  }
};

const silenceFrame = Buffer.alloc(8000, 0xff).toString('base64');

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
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
</Response>
`);
});

/* ========================
   START CALL
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
      {
        auth: {
          username: TWILIO_ACCOUNT_SID,
          password: TWILIO_AUTH_TOKEN
        }
      }
    );

    log('TWILIO', 'Call created', result.data.sid);
    res.json({ ok: true });
  } catch (e) {
    log('TWILIO', 'CALL FAILED', e.response?.data || e.message);
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
  if (url.pathname !== '/stream') return socket.destroy();

  wss.handleUpgrade(req, socket, head, ws => {
    ws.callSid = url.searchParams.get('callSid');
    log('WS', 'Upgrade OK', ws.callSid);
    wss.emit('connection', ws);
  });
});

/* ========================
   GEMINI
======================== */
async function callGemini(callSid, text) {
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
    log('GEMINI', 'ERROR', e.response?.data || e.message);
    return null;
  }
}

/* ========================
   ELEVENLABS
======================== */
async function tts(text) {
  log('TTS', 'Generating audio');
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
    { text },
    { headers: { 'xi-api-key': ELEVENLABS_KEY }, responseType: 'arraybuffer' }
  );
  log('TTS', 'Audio bytes', r.data.byteLength);
  return Buffer.from(r.data);
}

async function convert(buffer) {
  return new Promise(resolve => {
    const ff = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      'pipe:1'
    ]);
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

  let twilioReady = false;

  // keep-alive
  const keepAlive = setInterval(() => {
    if (twilioReady) {
      log('AUDIO', 'Sending silence keepalive');
      ws.send(JSON.stringify({ event: 'media', media: { payload: silenceFrame } }));
    }
  }, 500);

  // Deepgram
  const dg = new WebSocket(
    'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000',
    { headers: { Authorization: `Token ${DG_API_KEY}` } }
  );

  dg.on('open', () => log('DEEPGRAM', 'Connected'));

  dg.on('message', async msg => {
    const data = JSON.parse(msg.toString());
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript) return;

    log('DEEPGRAM', 'Transcript:', transcript);

    const reply = await callGemini(callSid, transcript);
    if (!reply) return;

    const audio = await convert(await tts(reply));

    log('AUDIO', 'Sending audio to Twilio');
    ws.send(JSON.stringify({ event: 'media', media: { payload: audio } }));
  });

  ws.on('message', msg => {
    const data = JSON.parse(msg.toString());

    if (data.event === 'start') {
      log('TWILIO', 'Stream started', data.start.callSid);
      twilioReady = true;
      return;
    }

    if (data.event === 'media') {
      log('AUDIO', 'Received audio from Twilio');
      dg.send(Buffer.from(data.media.payload, 'base64'));
    }

    if (data.event === 'stop') {
      log('TWILIO', 'Stream stopped by Twilio');
    }
  });

  ws.on('close', () => {
    log('WS', 'CLOSED', callSid);
    clearInterval(keepAlive);
    dg.close();
  });

  ws.on('error', e => log('WS', 'ERROR', e));
});

/* ========================
   START
======================== */
server.listen(port, () =>
  console.log(`✅ Server listening on ${port}`)
);
