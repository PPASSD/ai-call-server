// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const { URLSearchParams } = require('url');

const app = express();
const port = process.env.PORT || 10000;

// ========================
// ENV Variables
// ========================
const PUBLIC_HOST = process.env.PUBLIC_HOST;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const DG_API_KEY = process.env.DG_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY;
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GEMINI_MODEL = process.env.GEMINI_MODEL;

// Validate required ENV variables
const requiredEnvs = [
  'PUBLIC_HOST', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_NUMBER', 'DG_API_KEY', 'GEMINI_API_KEY', 
  'ELEVENLABS_KEY', 'ELEVENLABS_VOICE', 'GCP_PROJECT_ID', 'GEMINI_MODEL'
];
const missingEnvs = requiredEnvs.filter(v => !process.env[v]);
if (missingEnvs.length > 0) {
  console.error('Missing required environment variables:', missingEnvs);
  process.exit(1);
}

// In-memory mapping callSid -> lead info
const callMap = {};

// ========================
// Express setup
// ========================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------
// Sanitize phone number
// -------------------
function sanitizePhone(raw) {
  if (!raw) return null;
  let s = raw.toString().trim();
  s = s.replace(/\D/g, '');
  if (s.length === 10) s = '1' + s;
  if (s.length === 11 && s.startsWith('1')) s = '+' + s;
  else s = '+' + s;
  return s;
}

// -------------------
// Healthcheck route
// -------------------
app.get('/test', (req, res) => {
  res.json({ status: 'Server is running!' });
});

// -------------------
// Twilio Voice Webhook
// -------------------
app.post('/twilio-voice-webhook', (req, res) => {
  try {
    const callSid = req.body.CallSid || req.body.callSid;
    const phone = req.query.phone || 'unknown';
    callMap[callSid] = callMap[callSid] || { phone };

    const twiml = `
      <Response>
        <Start>
          <Stream url="wss://${PUBLIC_HOST}/stream?phone=${encodeURIComponent(phone)}&callSid=${callSid}" />
        </Start>
        <Say voice="alice">Hi, connecting you now.</Say>
      </Response>
    `;
    console.log('[twilio-voice-webhook] callSid:', callSid, 'phone:', phone);
    res.type('text/xml').send(twiml);
  } catch (err) {
    console.error('[twilio-voice-webhook] error:', err.message);
    res.status(500).send('<Response><Say>There was an error. Goodbye.</Say></Response>');
  }
});

// -------------------
// GHL webhook: /start-call
// -------------------
app.post('/start-call', async (req, res) => {
  const payload = req.body;
  console.log('[start-call] Payload:', payload);

  const phone = sanitizePhone(payload.phone);
  const name = payload.name || 'Unknown';
  if (!phone) return res.status(400).json({ success: false, error: 'Invalid phone' });

  const twilioWebhookUrl = `https://${PUBLIC_HOST}/twilio-voice-webhook?phone=${encodeURIComponent(phone)}`;
  const params = new URLSearchParams({ To: phone, From: TWILIO_NUMBER, Url: twilioWebhookUrl });

  try {
    const twilioRes = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`,
      params.toString(),
      {
        auth: { username: TWILIO_SID, password: TWILIO_AUTH_TOKEN },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    callMap[twilioRes.data.sid] = { phone, name };
    console.log('[start-call] Twilio call created:', twilioRes.data.sid);
    res.json({ success: true, callSid: twilioRes.data.sid });
  } catch (err) {
    console.error('[start-call] Twilio error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// ========================
// HTTP + WebSocket Server
// ========================
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// -------------------
// Handle Twilio MediaStream WS explicitly at /stream
// -------------------
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const pathname = url.pathname;
  const callSid = url.searchParams.get('callSid') || 'unknown';
  const phone = url.searchParams.get('phone') || 'unknown';
  const leadInfo = callMap[callSid] || { phone };

  console.log('[WS Upgrade] Path:', pathname, 'callSid:', callSid, 'phone:', phone);

  if (pathname === '/stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.callSid = callSid;
      ws.phone = phone;
      ws.leadInfo = leadInfo;
      console.log(`[WS] New connection for callSid=${callSid}`);
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy(); // reject other WS paths
  }
});


// -------------------
// ElevenLabs TTS Helper
// -------------------
async function elevenLabsTTSBuffer(text) {
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`;
    const body = { text, voice_settings: { stability: 0.5, similarity_boost: 0.7 } };
    const resp = await axios.post(url, body, {
      headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 20000
    });
    return Buffer.from(resp.data);
  } catch (err) {
    console.error('[ElevenLabs TTS] error:', err.message);
    return null;
  }
}

// -------------------
// Gemini WS Helper
// -------------------
function createGeminiWS(onChunk, onClose) {
  try {
    const geminiUrl = `wss://generativelanguage.googleapis.com/v1beta/projects/${GCP_PROJECT_ID}/locations/us-central1/models/${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}`;
    const gws = new WebSocket(geminiUrl);

    gws.on('open', () => console.log('[Gemini] connected'));
    gws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        const candidate = data?.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text;
        if (text) onChunk(text);
      } catch (err) {
        console.error('[Gemini] parse error', err.message);
      }
    });
    gws.on('close', () => { console.log('[Gemini] closed'); if (onClose) onClose(); });
    gws.on('error', (err) => console.error('[Gemini] error', err.message));
    return gws;
  } catch (err) {
    console.error('[createGeminiWS] error:', err.message);
    return null;
  }
}

// -------------------
// WebSocket Connection: Twilio -> DeepGram -> Gemini -> ElevenLabs -> Twilio
// -------------------
wss.on('connection', (ws) => {
  const callSid = ws.callSid;
  const phone = ws.phone;
  console.log(`[WS] MediaStream connected: callSid=${callSid} phone=${phone}`);

  // DeepGram WS
  const dgWS = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova&language=en-US', {
    headers: { Authorization: `Token ${DG_API_KEY}` }
  });

  dgWS.on('open', () => console.log(`[DeepGram] WS open for callSid=${callSid}`));

  dgWS.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'transcript') {
        const transcript = data.channel.alternatives[0].transcript;
        console.log(`[DeepGram][${callSid}] transcript:`, transcript);
        if (transcript.trim() !== '' && geminiWS && geminiWS.readyState === WebSocket.OPEN) {
          geminiWS.send(JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: transcript }] }],
            generationConfig: { maxOutputTokens: 180, temperature: 0.35, topP: 0.9 }
          }));
        }
      }
    } catch (err) {
      console.error('[DeepGram WS] parse error', err.message);
    }
  });

  dgWS.on('close', () => console.log(`[DeepGram] WS closed for callSid=${callSid}`));
  dgWS.on('error', (err) => console.error('[DeepGram WS] error', err.message));

  // Gemini WS
  const geminiWS = createGeminiWS(async (replyChunk) => {
    const ttsBuffer = await elevenLabsTTSBuffer(replyChunk);
    if (!ttsBuffer) return;
    const base64Audio = ttsBuffer.toString('base64');
    ws.send(JSON.stringify({ event: 'media', media: { payload: base64Audio } }));
    console.log(`[Gemini->Reply][${callSid}]`, replyChunk);
  });

  // Twilio MediaStream -> DeepGram
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'media' && data.media?.payload && dgWS.readyState === WebSocket.OPEN) {
        dgWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
      } else if (data.event === 'stop' && dgWS.readyState === WebSocket.OPEN) {
        dgWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }
    } catch (err) {
      console.error('[WS message] parse error', err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Twilio stream closed: ${callSid}`);
    if (dgWS.readyState === WebSocket.OPEN) dgWS.close();
    if (geminiWS && geminiWS.readyState === WebSocket.OPEN) geminiWS.close();
    delete callMap[callSid];
  });

  ws.on('error', (err) => console.error(`[WS] error: ${err.message}`));
});

// ========================
// Start Server
// ========================
server.listen(port, () => console.log(`AI Call Server listening on port ${port}`));
