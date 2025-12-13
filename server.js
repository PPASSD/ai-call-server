require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const { URLSearchParams } = require('url');

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

console.log('[BOOT] Gemini model:', GEMINI_MODEL);

/* ========================
   In-memory call store
======================== */
const callMap = {};

/* ========================
   Express
======================== */
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/test', (_, res) => res.json({ ok: true }));

/* ========================
   Helpers
======================== */
function sanitizePhone(raw) {
  let s = raw.replace(/\D/g, '');
  if (s.length === 10) s = '1' + s;
  return '+' + s;
}

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  );
}

/* ========================
   TWILIO VOICE WEBHOOK
======================== */
app.post('/twilio-voice-webhook', (req, res) => {
  const callSid = req.body.CallSid;
  const phone = req.query.phone || 'unknown';

  console.log('[Twilio Webhook] Incoming call:', callSid, phone);

  callMap[callSid] = { phone };

  const streamUrl = `wss://${PUBLIC_HOST}/stream?callSid=${callSid}&phone=${encodeURIComponent(phone)}`;

  const twiml = `
<Response>
  <Start>
    <Stream url="${escapeXml(streamUrl)}" />
  </Start>
  <Say>Hi, connecting you now.</Say>
</Response>`;

  res.type('text/xml').send(twiml);
});

/* ========================
   START CALL (GoHighLevel)
======================== */
app.post('/start-call', async (req, res) => {
  console.log('[Start-Call] Payload received:', req.body);

  const phone = sanitizePhone(req.body.phone);
  const webhookUrl = `https://${PUBLIC_HOST}/twilio-voice-webhook?phone=${encodeURIComponent(phone)}`;

  try {
    const params = new URLSearchParams({
      To: phone,
      From: TWILIO_NUMBER,
      Url: webhookUrl
    });

    const result = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
      params.toString(),
      {
        auth: {
          username: TWILIO_ACCOUNT_SID,
          password: TWILIO_AUTH_TOKEN
        },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    console.log('[Start-Call] Twilio call created:', result.data.sid);
    res.json({ success: true });
  } catch (err) {
    console.error('[Start-Call] ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: 'Call failed' });
  }
});

/* ========================
   HTTP + WS SERVER
======================== */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.pathname !== '/stream') return socket.destroy();

  wss.handleUpgrade(req, socket, head, ws => {
    ws.callSid = url.searchParams.get('callSid');
    ws.phone = url.searchParams.get('phone');
    wss.emit('connection', ws);
  });
});

/* ========================
   GEMINI (HTTP — CORRECT)
======================== */
async function callGemini(prompt) {
  console.log('[Gemini] Prompt:', prompt);

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    },
    {
      params: { key: GEMINI_API_KEY },
      headers: { 'Content-Type': 'application/json' }
    }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log('[Gemini] Response:', text);
  return text;
}

/* ========================
   ELEVENLABS
======================== */
async function tts(text) {
  console.log('[TTS] Generating audio');
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
    { text },
    {
      headers: { 'xi-api-key': ELEVENLABS_KEY },
      responseType: 'arraybuffer'
    }
  );
  return Buffer.from(r.data).toString('base64');
}

/* ========================
   WS CONNECTION
======================== */
wss.on('connection', ws => {
  console.log('[WS] Twilio MediaStream connected:', ws.callSid);

  const dg = new WebSocket(
    'wss://api.deepgram.com/v1/listen?model=nova&language=en-US',
    { headers: { Authorization: `Token ${DG_API_KEY}` } }
  );

  dg.on('open', () => console.log('[Deepgram] Connected'));

  dg.on('message', async msg => {
    const data = JSON.parse(msg.toString());
    const transcript = data.channel?.alternatives?.[0]?.transcript;

    if (!transcript) return;
    console.log('[Deepgram] Transcript:', transcript);

    const reply = await callGemini(transcript);
    if (!reply) return;

    const audio = await tts(reply);
    ws.send(JSON.stringify({
      event: 'media',
      media: { payload: audio }
    }));
  });

  ws.on('message', msg => {
    const data = JSON.parse(msg.toString());
    if (data.event === 'media') {
      dg.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: data.media.payload
      }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Closed:', ws.callSid);
    dg.close();
  });
});

/* ========================
   START
======================== */
server.listen(port, () =>
  console.log(`🚀 AI Call Server running on port ${port}`)
);
