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

// In-memory mapping: phone -> call info
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
  if (s.length === 11 && s.startsWith('1')) return '+' + s;
  return '+' + s;
}

// ========================
// GoHighLevel webhook endpoint: /start-call
// ========================
app.post('/start-call', async (req, res) => {
  const phone = sanitizePhone(req.body.phone);
  const name = req.body.name || 'Unknown';
  const email = req.body.email || 'unknown';
  const source = req.body.source || 'unknown';

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

    callMap[phone] = { callSid: twilioRes.data.sid, name, email, source };
    console.log(`[start-call] Call created for ${phone}: ${twilioRes.data.sid}`);
    res.json({ success: true, callSid: twilioRes.data.sid });
  } catch (err) {
    console.error('[start-call] Twilio error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// ========================
// Twilio Voice Webhook: /twilio-voice-webhook
// ========================
app.post('/twilio-voice-webhook', (req, res) => {
  const phone = req.query.phone;
  const info = callMap[phone] || { name: 'Unknown' };

  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${PUBLIC_HOST}/stream?phone=${encodeURIComponent(phone)}" />
      </Start>
      <Say voice="alice">Hi ${info.name}, connecting you now.</Say>
    </Response>
  `;
  res.type('text/xml').send(twiml);
});

// ========================
// HTTP + WebSocket Server
// ========================
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const phone = url.searchParams.get('phone');
  const callInfo = callMap[phone] || { name: 'Unknown' };

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.phone = phone;
    ws.callInfo = callInfo;
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
// Gemini WS Helper
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
  gws.on('close', () => { console.log('[Gemini] closed'); if (onClose) onClose(); });
  gws.on('error', (err) => console.error('[Gemini] error', err.message));
  return gws;
}

// ========================
// Twilio MediaStream WS Handler
// ========================
wss.on('connection', (ws) => {
  const phone = ws.phone;
  const info = ws.callInfo;
  console.log(`[WS] MediaStream connected for phone=${phone}`);

  const dgWS = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova&language=en-US', {
    headers: { Authorization: `Token ${DG_API_KEY}` }
  });

  dgWS.on('open', () => console.log(`[DeepGram] WS open for phone=${phone}`));

  const geminiWS = createGeminiWS(async (replyChunk) => {
    const ttsBuffer = await elevenLabsTTSBuffer(replyChunk);
    if (!ttsBuffer) return;
    const base64Audio = ttsBuffer.toString('base64');
    ws.send(JSON.stringify({ event: 'media', media: { payload: base64Audio } }));
  });

  dgWS.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'transcript') {
        const transcript = data.channel.alternatives[0].transcript;
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

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.event === 'media' && data.media?.payload && dgWS.readyState === WebSocket.OPEN) {
      dgWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
    } else if (data.event === 'stop' && dgWS.readyState === WebSocket.OPEN) {
      dgWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Twilio stream closed for phone=${phone}`);
    if (dgWS.readyState === WebSocket.OPEN) dgWS.close();
    if (geminiWS.readyState === WebSocket.OPEN) geminiWS.close();
    delete callMap[phone];
  });

  ws.on('error', (err) => console.error(`[WS] error: ${err.message}`));
});

server.listen(port, () => console.log(`AI Call Server listening on port ${port}`));
