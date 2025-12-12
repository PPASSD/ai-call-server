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
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const DG_API_KEY = process.env.DG_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY;
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE || 'vBKc2FfBKJfcZNyEt1n6';
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'ai-call-server-zqvh.onrender.com';

// ========================
// In-memory call mapping
// phone -> lead info
// ========================
const callMap = {};

// ========================
// Express setup
// ========================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------
// Phone sanitizer
// -------------------
function sanitizePhone(raw) {
  if (!raw) return null;
  let s = raw.toString().trim();
  if (s.startsWith('{{') && s.endsWith('}}')) return null;
  s = s.replace(/\D/g, '');
  if (s.length === 10) s = '1' + s;
  if (s.length === 11 && s.startsWith('1')) return '+' + s;
  return '+' + s;
}

// ========================
// Twilio Voice Webhook
// ========================
app.post('/twilio-voice-webhook', (req, res) => {
  const phone = req.query.phone || 'unknown';
  callMap[phone] = callMap[phone] || { phone };

  const twiml = `
<Response>
  <Start>
    <Stream url="wss://${PUBLIC_HOST}/stream?phone=${encodeURIComponent(phone)}" />
  </Start>
  <Say voice="alice">Hi, connecting you now.</Say>
</Response>
  `;

  console.log('[twilio-voice-webhook] phone:', phone);
  res.type('text/xml').send(twiml);
});

// ========================
// GHL webhook: /start-call
// ========================
app.post('/start-call', async (req, res) => {
  console.log('[start-call] Payload:', req.body);

  const phone = sanitizePhone(req.body.phone);
  const name = req.body.name || 'Unknown';
  const email = req.body.email || '';
  const source = req.body.source || '';

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

    callMap[phone] = { phone, name, email, source };
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
// Handle Twilio MediaStream WS Upgrade
// -------------------
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const phone = url.searchParams.get('phone') || 'unknown';
  const leadInfo = callMap[phone] || { phone };

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.phone = phone;
    ws.leadInfo = leadInfo;
    wss.emit('connection', ws, request);
  });
});

// ========================
// ElevenLabs TTS Helper
// ========================
async function elevenLabsTTSBuffer(text) {
  if (!text) return null;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`;
  const body = { text, voice_settings: { stability: 0.5, similarity_boost: 0.7 } };
  const resp = await axios.post(url, body, {
    headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
    responseType: 'arraybuffer',
    timeout: 20000
  });
  return Buffer.from(resp.data);
}

// ========================
// Gemini 2.5 Flash-lite Helper
// ========================
function createGeminiWS(onChunk, onClose) {
  const geminiUrl = `wss://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${GEMINI_API_KEY}`;
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
  gws.on('close', (code, reason) => {
    console.log(`[Gemini] closed: code=${code} reason=${reason}`);
    if (onClose) onClose();
  });
  gws.on('error', (err) => console.error('[Gemini] WS error', err.message));
  return gws;
}

// ========================
// Twilio WS Connection: MediaStream -> DeepGram -> Gemini -> ElevenLabs -> Twilio
// ========================
wss.on('connection', (ws) => {
  const phone = ws.phone;
  const lead = ws.leadInfo;
  console.log(`[WS] MediaStream connected: phone=${phone}`, lead);

  // DeepGram WS
  const dgWS = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova&language=en-US', {
    headers: { Authorization: `Token ${DG_API_KEY}` }
  });

  dgWS.on('open', () => console.log(`[DeepGram] WS open for phone=${phone}`));
  dgWS.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'transcript') {
        const transcript = data.channel.alternatives[0].transcript;
        console.log(`[DeepGram][${phone}] transcript:`, transcript);
        if (transcript.trim() !== '' && geminiWS.readyState === WebSocket.OPEN) {
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
  dgWS.on('error', (err) => console.error('[DeepGram WS] error', err.message));
  dgWS.on('close', () => console.log(`[DeepGram] WS closed for phone=${phone}`));

  // Gemini WS
  const geminiWS = createGeminiWS(async (replyChunk) => {
    console.log(`[Gemini->Reply][${phone}]`, replyChunk);
    const ttsBuffer = await elevenLabsTTSBuffer(replyChunk);
    if (!ttsBuffer) return;
    const base64Audio = ttsBuffer.toString('base64');
    ws.send(JSON.stringify({ event: 'media', media: { payload: base64Audio } }));
  }, () => { try { geminiWS.close(); } catch (e) {} });

  // Twilio MediaStream -> DeepGram
  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.event === 'media' && data.media?.payload && dgWS.readyState === WebSocket.OPEN) {
      dgWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
    } else if (data.event === 'stop' && dgWS.readyState === WebSocket.OPEN) {
      dgWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Twilio stream closed: ${phone}`);
    if (dgWS.readyState === WebSocket.OPEN) dgWS.close();
    if (geminiWS.readyState === WebSocket.OPEN) geminiWS.close();
    delete callMap[phone];
  });

  ws.on('error', (err) => console.error(`[WS] error: ${err.message}`));
});

// ========================
// Start Server
// ========================
server.listen(port, () => console.log(`AI Call Server listening on port ${port}`));
