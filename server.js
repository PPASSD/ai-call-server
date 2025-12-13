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
const GEMINI_MODEL = process.env.GEMINI_MODEL; // gemini-2.5-flash-lite
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY;
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;

// Validate required ENV variables
const requiredEnvs = [
  'PUBLIC_HOST', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_NUMBER', 'DG_API_KEY', 'GEMINI_API_KEY',
  'GEMINI_MODEL', 'ELEVENLABS_KEY', 'ELEVENLABS_VOICE', 'GCP_PROJECT_ID'
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
// Healthcheck
// -------------------
app.get('/test', (req, res) => res.json({ status: 'Server running' }));

// -------------------
// Escape XML helper
// -------------------
function escapeXml(unsafe) {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// -------------------
// Twilio Voice Webhook
// -------------------
app.post('/twilio-voice-webhook', (req, res) => {
  try {
    const callSid = req.body.CallSid || req.body.callSid;
    const phone = req.query.phone || 'unknown';
    callMap[callSid] = callMap[callSid] || { phone };

    const streamUrl = `wss://${PUBLIC_HOST}/stream?phone=${encodeURIComponent(phone)}&callSid=${encodeURIComponent(callSid)}`;
    const twiml = `
      <Response>
        <Start>
          <Stream url="${escapeXml(streamUrl)}" />
        </Start>
        <Say voice="alice">Hi, connecting you now.</Say>
      </Response>
    `;
    console.log('[Twilio Webhook] Incoming call callSid=', callSid, 'phone=', phone);
    console.log('[Twilio Webhook] Returning TwiML for callSid=', callSid);
    res.type('text/xml').send(twiml);
  } catch (err) {
    console.error('[Twilio Webhook] error:', err.message);
    res.status(500).send('<Response><Say>There was an error. Goodbye.</Say></Response>');
  }
});

// -------------------
// GHL /start-call webhook
// -------------------
app.post('/start-call', async (req, res) => {
  console.log('[Start-Call] Payload received:', req.body);
  const phone = sanitizePhone(req.body.phone);
  const name = req.body.name || 'Unknown';
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
    console.log('[Start-Call] Twilio call created:', twilioRes.data.sid);
    res.json({ success: true, callSid: twilioRes.data.sid });
  } catch (err) {
    console.error('[Start-Call] Twilio error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// ========================
// HTTP + WebSocket Server
// ========================
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// -------------------
// WebSocket Upgrade
// -------------------
server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url, `https://${request.headers.host}`);
    const pathname = url.pathname;
    const callSid = url.searchParams.get('callSid') || 'unknown';
    const phone = url.searchParams.get('phone') || 'unknown';
    console.log('[WS Upgrade] Path:', pathname, 'callSid:', callSid, 'phone:', phone);

    if (pathname === '/stream') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.callSid = callSid;
        ws.phone = phone;
        ws.leadInfo = callMap[callSid] || { phone };
        console.log(`[WS] Connection established for callSid=${callSid}`);
        wss.emit('connection', ws, request);
      });
    } else {
      console.warn('[WS Upgrade] Unknown path, destroying socket');
      socket.destroy();
    }
  } catch (err) {
    console.error('[WS Upgrade] error:', err);
    socket.destroy();
  }
});

// -------------------
// WebSocket Connection Handler
// -------------------
wss.on('connection', (ws) => {
  const callSid = ws.callSid;
  const phone = ws.phone;
  console.log(`[WS] MediaStream connected: callSid=${callSid} phone=${phone}`);

  // ------------------- DeepGram WS -------------------
  const dgWS = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova&language=en-US', {
    headers: { Authorization: `Token ${DG_API_KEY}` }
  });
  dgWS.on('open', () => console.log(`[DeepGram] WS open for callSid=${callSid}`));
  dgWS.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'transcript') {
        const transcript = data.channel.alternatives[0].transcript;
        console.log(`[DeepGram][${callSid}] transcript:`, transcript);

        // Send transcript to Gemini if ready
        if (geminiWS && geminiWS.readyState === WebSocket.OPEN && transcript.trim() !== '') {
          geminiWS.send(JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: transcript }] }],
            conversation: [],
            temperature: 0.3,
            maxOutputTokens: 250
          }));
        }
      }
    } catch (err) {
      console.error('[DeepGram] parse error:', err.message);
    }
  });
  dgWS.on('close', () => console.log(`[DeepGram] WS closed for callSid=${callSid}`));
  dgWS.on('error', (err) => console.error('[DeepGram WS] error:', err.message));

  // ------------------- Gemini WS -------------------
  const geminiWS = new WebSocket(
    `wss://generativelanguage.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}`
  );
  geminiWS.on('open', () => console.log(`[Gemini] WS connected for callSid=${callSid}`));
  geminiWS.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      if (text) {
        console.log(`[Gemini Reply][${callSid}]`, text);

        // Send reply to ElevenLabs TTS and then Twilio
        const ttsBuffer = await elevenLabsTTSBuffer(text);
        if (ttsBuffer) {
          const base64Audio = ttsBuffer.toString('base64');
          ws.send(JSON.stringify({ event: 'media', media: { payload: base64Audio } }));
        }
      }
    } catch (err) {
      console.error('[Gemini WS] parse error:', err.message);
    }
  });
  geminiWS.on('close', () => console.log(`[Gemini] WS closed for callSid=${callSid}`));
  geminiWS.on('error', (err) => console.error('[Gemini WS] error:', err.message));

  // ------------------- Twilio MediaStream -> DeepGram -------------------
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'media' && data.media?.payload && dgWS.readyState === WebSocket.OPEN) {
        dgWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
      } else if (data.event === 'stop' && dgWS.readyState === WebSocket.OPEN) {
        dgWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }
    } catch (err) {
      console.error('[WS message parse] error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Twilio stream closed: callSid=${callSid}`);
    if (dgWS.readyState === WebSocket.OPEN) dgWS.close();
    if (geminiWS.readyState === WebSocket.OPEN) geminiWS.close();
    delete callMap[callSid];
  });

  ws.on('error', (err) => console.error(`[WS] error: ${err.message}`));
});

// -------------------
// ElevenLabs TTS helper
// -------------------
async function elevenLabsTTSBuffer(text) {
  try {
    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
      { text, voice_settings: { stability: 0.5, similarity_boost: 0.7 } },
      { headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
    );
    return Buffer.from(resp.data);
  } catch (err) {
    console.error('[ElevenLabs TTS] error:', err.message);
    return null;
  }
}

// -------------------
// Start server
// -------------------
server.listen(port, () => console.log(`AI Call Server listening on port ${port}`));
