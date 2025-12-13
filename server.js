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
  ELEVENLABS_VOICE
} = process.env;

console.log('[BOOT] Gemini model:', GEMINI_MODEL);

/* ========================
   In-memory storage
======================== */
const callMap = {};
const conversationMemory = {};

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

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

/* ========================
   Convert audio for Twilio
======================== */
async function convertToTwilioFormat(buffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      'pipe:1'
    ]);

    const chunks = [];
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', () => {}); // ignore logs

    ffmpeg.on('close', () => {
      resolve(Buffer.concat(chunks).toString('base64'));
    });

    ffmpeg.stdin.write(buffer);
    ffmpeg.stdin.end();
  });
}

/* ========================
   Twilio Voice Webhook
======================== */
app.post('/twilio-voice-webhook', (req, res) => {
  const callSid = req.body.CallSid;
  console.log('[Twilio Webhook] Incoming call:', callSid);

  callMap[callSid] = { startTime: Date.now() };
  conversationMemory[callSid] = [];

  const streamUrl = `wss://${PUBLIC_HOST}/stream?callSid=${callSid}`;
  const twiml = `
<Response>
  <Start>
    <Stream url="${escapeXml(streamUrl)}" />
  </Start>
</Response>`;
  res.type('text/xml').send(twiml);
});

/* ========================
   Start Call (GoHighLevel)
======================== */
app.post('/start-call', async (req, res) => {
  const phone = sanitizePhone(req.body.phone);
  const webhookUrl = `https://${PUBLIC_HOST}/twilio-voice-webhook`;

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
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    console.log('[Start-Call] Twilio call created:', result.data.sid);
    res.json({ success: true, callSid: result.data.sid });
  } catch (err) {
    console.error('[Start-Call] ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: 'Call failed' });
  }
});

/* ========================
   HTTP + WS Server
======================== */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.pathname !== '/stream') return socket.destroy();

  wss.handleUpgrade(req, socket, head, ws => {
    ws.callSid = url.searchParams.get('callSid');
    console.log('[WS Upgrade] New connection', ws.callSid);
    wss.emit('connection', ws);
  });
});

/* ========================
   Gemini API
======================== */
async function callGemini(prompt, memory = []) {
  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`,
      {
        contents: [
          ...memory.map(m => ({ role: 'user', parts: [{ text: m }] })),
          { role: 'user', parts: [{ text: prompt }] }
        ]
      },
      { params: { key: GEMINI_API_KEY }, headers: { 'Content-Type': 'application/json' } }
    );
    return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (err) {
    console.error('[Gemini] ERROR:', err.response?.data || err.message);
    return '';
  }
}

/* ========================
   ElevenLabs TTS
======================== */
async function tts(text) {
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
    { text },
    { headers: { 'xi-api-key': ELEVENLABS_KEY }, responseType: 'arraybuffer' }
  );
  return Buffer.from(r.data);
}

/* ========================
   Send initial silence to keep call alive
======================== */
function sendInitialSilence(ws) {
  const silence = Buffer.alloc(8000, 0xFF).toString('base64');
  safeSend(ws, { event: 'media', media: { payload: silence } });
}

/* ========================
   WS Connection
======================== */
wss.on('connection', ws => {
  const callSid = ws.callSid;
  console.log('[WS] MediaStream connected', callSid);
  let twilioReady = false;

  // Keep-alive interval
  const keepAliveInterval = setInterval(() => {
    if (twilioReady) sendInitialSilence(ws);
  }, 500);

  // -------------------
  // Deepgram
  // -------------------
  const dg = new WebSocket(
    'wss://api.deepgram.com/v1/listen?model=nova-2&language=en-US&encoding=mulaw&sample_rate=8000&channels=1',
    { headers: { Authorization: `Token ${DG_API_KEY}` } }
  );

  dg.on('open', () => console.log('[Deepgram] Connected'));

  dg.on('message', async msg => {
    const data = JSON.parse(msg.toString());
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript || !callSid) return;
    console.log('[Deepgram] Transcript:', transcript);

    conversationMemory[callSid].push(transcript);

    const reply = await callGemini(transcript, conversationMemory[callSid]);
    if (!reply) return;

    console.log('[Gemini Reply]:', reply);
    conversationMemory[callSid].push(reply);

    const elevenAudio = await tts(reply);
    const twilioAudio = await convertToTwilioFormat(elevenAudio);

    if (twilioReady) safeSend(ws, { event: 'media', media: { payload: twilioAudio } });
  });

  ws.on('message', msg => {
    const data = JSON.parse(msg.toString());

    if (data.event === 'start') {
      console.log('[Twilio] Stream started for CallSid:', callSid);
      twilioReady = true;

      // Send initial TTS greeting or silence
      sendInitialSilence(ws);
      return;
    }

    if (data.event === 'media' && dg.readyState === WebSocket.OPEN) {
      const audioBuffer = Buffer.from(data.media.payload, 'base64');
      dg.send(audioBuffer);
    }
  });

  ws.on('close', () => {
    console.log('[WS CLOSED]', callSid);
    clearInterval(keepAliveInterval);
    if (dg.readyState === WebSocket.OPEN) dg.close();
    delete callMap[callSid];
    delete conversationMemory[callSid];
  });

  ws.on('error', e => console.error('[WS ERROR]', e));
});

/* ========================
   Start server
======================== */
server.listen(port, () => console.log(`🚀 AI Call Server running on port ${port}`));
