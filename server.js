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
  if (s.length === 11 && s.startsWith('1')) return '+' + s;
  return null;
}

// ========================
// 1️⃣ GHL Webhook: Start Call
// ========================
app.post('/start-call', async (req, res) => {
  console.log('[start-call] Payload:', req.body);

  const phone = sanitizePhone(req.body.phone);
  const name = req.body.name || 'Unknown';
  const contact_id = req.body.contact_id || 'unknown';

  if (!phone) return res.status(400).json({ success: false, error: 'Invalid phone number' });

  try {
    // Twilio webhook URL for the call
    const twilioWebhookUrl = `https://${PUBLIC_HOST}/twilio-voice-webhook?contact_id=${encodeURIComponent(contact_id)}`;

    const params = new URLSearchParams({
      To: phone,
      From: TWILIO_NUMBER,
      Url: twilioWebhookUrl
    });

    const twilioRes = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`,
      params.toString(),
      {
        auth: { username: TWILIO_SID, password: TWILIO_AUTH_TOKEN },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    // Save info for later WS mapping
    callMap[twilioRes.data.sid] = { contact_id, phone, name };
    console.log(`[start-call] Twilio call created: ${twilioRes.data.sid}`);

    res.json({ success: true, callSid: twilioRes.data.sid });
  } catch (err) {
    console.error('[start-call] Twilio error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// ========================
// 2️⃣ Twilio Voice Webhook: Return TwiML for MediaStream
// ========================
app.post('/twilio-voice-webhook', (req, res) => {
  const CallSid = req.body.CallSid;
  const contact_id = req.query.contact_id || 'unknown';

  console.log('[twilio-voice-webhook] CallSid:', CallSid, 'contact_id:', contact_id);

  // Map the callSid to contact info if not already mapped
  callMap[CallSid] = callMap[CallSid] || { contact_id };

  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${PUBLIC_HOST}/stream?callSid=${CallSid}" />
      </Start>
      <Say voice="alice">Hi, connecting you now.</Say>
    </Response>
  `;
  res.type('text/xml').send(twiml);
});

// ========================
// 3️⃣ HTTP + WebSocket Server
// ========================
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// -------------------
// Handle Twilio MediaStream WS Upgrade
// -------------------
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const callSid = url.searchParams.get('callSid');
  const leadInfo = callMap[callSid] || { contact_id: 'unknown' };

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.callSid = callSid;
    ws.leadInfo = leadInfo;
    wss.emit('connection', ws, request);
  });
});

// -------------------
// ElevenLabs TTS Helper
// -------------------
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

// -------------------
// Gemini WS Helper
// -------------------
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

// -------------------
// WS Connection: Twilio MediaStream -> DeepGram -> Gemini -> ElevenLabs -> Twilio
// -------------------
wss.on('connection', (ws) => {
  const callSid = ws.callSid;
  const lead = ws.leadInfo;
  console.log(`[WS] MediaStream connected: callSid=${callSid}`, lead);

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
  dgWS.on('close', () => console.log(`[DeepGram] WS closed for callSid=${callSid}`));

  // Gemini WS
  const geminiWS = createGeminiWS(async (replyChunk) => {
    console.log(`[Gemini->Reply][${callSid}]`, replyChunk);
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
    console.log(`[WS] Twilio stream closed: ${callSid}`);
    if (dgWS.readyState === WebSocket.OPEN) dgWS.close();
    if (geminiWS.readyState === WebSocket.OPEN) geminiWS.close();
    delete callMap[callSid];
  });

  ws.on('error', (err) => console.error(`[WS] error: ${err.message}`));
});

// ========================
// Start Server
// ========================
server.listen(port, () => console.log(`AI Call Server listening on port ${port}`));
