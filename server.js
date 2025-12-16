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
  DG_API_KEY,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  ELEVENLABS_KEY,
  ELEVENLABS_VOICE
} = process.env;

console.log('🚀 SERVER BOOTING');
console.log('🌐 PUBLIC_HOST:', PUBLIC_HOST);
console.log('🤖 GEMINI_MODEL:', GEMINI_MODEL);
console.log('🔊 ELEVENLABS_VOICE:', ELEVENLABS_VOICE);

/* ========================
   EXPRESS
======================== */
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const log = (flag, ...args) => console.log(`[${flag}]`, ...args);

/* ========================
   HEALTH
======================== */
app.get('/', (_, res) => res.send('✅ AI Call Server Alive'));
app.get('/health', (_, res) => res.json({ ok: true }));

/* ========================
   TWILIO VOICE WEBHOOK
======================== */
app.post('/twilio-voice-webhook', (req, res) => {
  log('TWILIO', 'Incoming call', req.body.CallSid);

  const wsUrl = `wss://${PUBLIC_HOST}/stream`;

  res.type('text/xml').send(`
<Response>
  <Say voice="alice">
    Hi, please hold while I connect you.
  </Say>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
  <Pause length="600" />
</Response>
`);
});

/* ========================
   SERVER + WS
======================== */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/stream')) return socket.destroy();

  wss.handleUpgrade(req, socket, head, ws => {
    log('WS', 'Upgrade OK (waiting for start)');
    wss.emit('connection', ws);
  });
});

/* ========================
   GEMINI
======================== */
async function callGemini(text) {
  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`,
      { contents: [{ role: 'user', parts: [{ text }] }] },
      { params: { key: GEMINI_API_KEY } }
    );
    return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) {
    console.error('🔥 GEMINI ERROR', e.response?.data || e.message);
    return null;
  }
}

/* ========================
   ELEVENLABS TTS
======================== */
async function tts(text) {
  console.log('🔊 [11LABS] Sending text:', text);

  try {
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
      {
        text,
        model_id: 'eleven_monolingual_v1'
      },
      {
        headers: {
          'xi-api-key': ELEVENLABS_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 15000
      }
    );

    const buffer = Buffer.from(r.data);
    console.log('🔊 [11LABS] Audio bytes:', buffer.length);

    if (buffer.length < 1000) return null;
    return buffer;
  } catch (err) {
    console.error(
      '🔥 [11LABS ERROR]',
      err.response?.status,
      err.response?.data?.toString() || err.message
    );
    return null;
  }
}

/* ========================
   AUDIO CONVERSION (FFMPEG)
======================== */
async function convertToMulaw(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      'pipe:1'
    ]);

    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));
    ff.stderr.on('data', d => console.error('🔥 FFMPEG ERROR:', d.toString()));

    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`FFmpeg exited with code ${code}`));
      const result = Buffer.concat(chunks);
      console.log('🔊 Converted audio length:', result.length);
      resolve(result);
    });

    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

/* ========================
   SEND AUDIO TO TWILIO
======================== */
async function sendAudio(ws, buffer) {
  if (!ws.streamSid || !buffer) return;

  try {
    const audio = await convertToMulaw(buffer);
    if (!audio || audio.length === 0) return console.warn('⚠️ No audio to send');

    for (let i = 0; i < audio.length; i += 320) {
      if (ws.readyState !== WebSocket.OPEN) return;

      ws.send(JSON.stringify({
        event: 'media',
        streamSid: ws.streamSid,
        media: {
          payload: audio.slice(i, i + 320).toString('base64'),
          track: 'outbound'
        }
      }));

      await new Promise(r => setTimeout(r, 20));
    }
  } catch (e) {
    console.error('🔥 sendAudio error', e);
  }
}

/* ========================
   WS HANDLER
======================== */
wss.on('connection', ws => {
  log('WS', 'Connected');

  let aiSpeaking = false;
  let lastTranscriptAt = 0;

  const dg = new WebSocket(
    `wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&endpointing=true`,
    { headers: { Authorization: `Token ${DG_API_KEY}` } }
  );

  dg.on('open', () => log('DEEPGRAM', 'Connected'));

  ws.on('message', async msg => {
    const data = JSON.parse(msg.toString());

    if (data.event === 'start') {
      ws.callSid = data.start.callSid;
      ws.streamSid = data.start.streamSid;

      log('TWILIO', 'Stream started', ws.callSid, ws.streamSid);

      aiSpeaking = true;
      const greeting = await tts('Hi, this is the pool assistant. How can I help you today?');
      if (greeting) await sendAudio(ws, greeting);
      aiSpeaking = false;
    }

    if (data.event === 'media' && !aiSpeaking && dg.readyState === WebSocket.OPEN) {
      dg.send(Buffer.from(data.media.payload, 'base64'));
    }
  });

  dg.on('message', async msg => {
    const data = JSON.parse(msg.toString());
    if (!data.is_final) return;

    const transcript = data.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript || transcript.length < 3) return;

    const now = Date.now();
    if (aiSpeaking || now - lastTranscriptAt < 900) return;
    lastTranscriptAt = now;

    log('DEEPGRAM', 'FINAL:', transcript);

    aiSpeaking = true;

    const reply = await callGemini(transcript);
    if (!reply) {
      aiSpeaking = false;
      return;
    }

    log('GEMINI', reply);

    const audio = await tts(reply);
    if (audio) await sendAudio(ws, audio);

    aiSpeaking = false;
  });

  ws.on('close', () => {
    log('WS', 'Closed', ws.callSid);
    dg.close();
  });
});

/* ========================
   START SERVER
======================== */
server.listen(port, () => console.log(`✅ Server listening on ${port}`));
