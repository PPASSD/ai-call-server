// server.js
// Full, production-ready server for: GHL -> Twilio -> Render WS -> DeepGram -> Gemini -> ElevenLabs -> Twilio
// Uses ElevenLabs voice: Finn vBKc2FfBKJfcZNyEt1n6
// NOTE: verify GEMINI websocket endpoint & auth for your Google Cloud setup if necessary.

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const { Buffer } = require('buffer');

const app = express();
const port = process.env.PORT || 10000;

// =========================
// Required environment vars
// =========================
// PUBLIC_HOST - host without protocol, e.g. ai-call-server-zqvh.onrender.com
// TWILIO_SID - Twilio Account SID
// TWILIO_AUTH_TOKEN - Twilio Auth Token
// TWILIO_NUMBER - e.g. +17603344484  (From number)
// DG_API_KEY - DeepGram API key
// GEMINI_API_KEY - Google API key for Generative Models (or whichever auth you use)
// ELEVENLABS_KEY - ElevenLabs xi-api-key
// ELEVENLABS_VOICE - voice id (default set below to Finn)
// OPTIONAL: ELEVENLABS_VOICE_NAME: friendly name for logs

const PUBLIC_HOST = process.env.PUBLIC_HOST || (() => {
  // fallback to extracting from BASE_URL or SERVER_URL if present
  const fallback = process.env.BASE_URL || process.env.SERVER_URL || '';
  return fallback.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'ai-call-server-zqvh.onrender.com';
})();

const TWILIO_SID = process.env.TWILIO_SID || process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || process.env.TWILIO_FROM_NUMBER;
const DG_API_KEY = process.env.DG_API_KEY || process.env.DEEPGRAM_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY || process.env.XI_API_KEY;
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE || 'vBKc2FfBKJfcZNyEt1n6'; // Finn voice id (provided)
const ELEVENLABS_VOICE_NAME = process.env.ELEVENLABS_VOICE_NAME || 'Finn';

if (!TWILIO_SID || !TWILIO_AUTH_TOKEN || !TWILIO_NUMBER) {
  console.warn('WARNING: Missing Twilio credentials in environment. Calls will fail until you set TWILIO_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER.');
}
if (!DG_API_KEY) {
  console.warn('WARNING: Missing DeepGram API key (DG_API_KEY).');
}
if (!GEMINI_API_KEY) {
  console.warn('WARNING: Missing GEMINI_API_KEY. Gemini streaming may fail without a valid key.');
}
if (!ELEVENLABS_KEY) {
  console.warn('WARNING: Missing ELEVENLABS_KEY. ElevenLabs TTS will fail without an API key.');
}

// =========================
// Express setup
// =========================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Map CallSid -> lead info (in-memory)
const callMap = {};

// Utility: sanitize phone numbers into E.164-ish (US)
function sanitizePhone(raw) {
  if (!raw) return null;
  let s = raw.toString().trim();
  // If it's in handlebars style empty "{{...}}", just return null
  if (s.startsWith('{{') && s.endsWith('}}')) return null;
  // strip non-digits
  s = s.replace(/\D/g, '');
  if (!s) return null;
  // If length 10 assume US, prefix 1
  if (s.length === 10) s = '1' + s;
  if (s.length === 11 && s.startsWith('1')) return '+' + s;
  // otherwise, return with plus
  return '+' + s;
}

function sanitizeContactId(raw) {
  if (!raw) return 'unknown';
  try {
    const s = raw.toString().trim();
    return s === '' ? 'unknown' : s;
  } catch (err) {
    return 'unknown';
  }
}

// ---------------- Twilio voice webhook route ----------------
// Twilio will POST here when it receives an outbound call created by our /call-lead
// Make sure Twilio's number Voice webhook is set to POST https://PUBLIC_HOST/twilio-voice-webhook
app.post('/twilio-voice-webhook', (req, res) => {
  // Twilio will send a bunch of fields; we want CallSid
  const CallSid = req.body.CallSid || req.body.CallSid || (req.body?.callSid) || null;
  const from = req.body.From || '';
  const to = req.body.To || '';

  // Attempt to find lead info in query params Twilio appended on the Outbound call (we attach in /call-lead)
  const contact_id = (req.query && req.query.contact_id) || req.body.contact_id || 'unknown';

  // store minimal lead info (callMap will get the entry when POST /call-lead created the outbound call)
  if (CallSid) {
    callMap[CallSid] = callMap[CallSid] || { contact_id, from, to };
  } else {
    console.warn('Incoming twilio webhook without CallSid', req.body);
  }

  // TwiML: Start MediaStream and say greeting
  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${PUBLIC_HOST}/stream?callSid=${CallSid || ''}" />
      </Start>
      <Say voice="alice">Hi — connecting you now.</Say>
    </Response>
  `;
  res.type('text/xml').send(twiml);
});

// ---------------- Outbound call endpoint (called by GHL webhook) ----------------
// GHL should POST to this endpoint with at least phone and contact_id.
// Example body:
// { "phone": "+17603344484", "name": "Brendan Wolpert", "contact_id": "RwUe..." }
app.post('/call-lead', async (req, res) => {
  // Log raw incoming payload for debugging
  console.log('Incoming /call-lead payload:', req.body);

  let phone = sanitizePhone(req.body?.phone || req.body?.to || req.body?.Phone);
  const name = req.body?.name || req.body?.full_name || 'Unknown';
  const contact_id = sanitizeContactId(req.body?.contact_id || req.body?.contact || req.body?.contactId);

  if (!phone) {
    return res.status(400).json({ success: false, error: 'Invalid or missing phone number' });
  }

  // Choose Twilio's call webhook URL that Twilio will hit when the call connects
  const twilioWebhookUrl = `https://${PUBLIC_HOST}/twilio-voice-webhook?contact_id=${encodeURIComponent(contact_id)}`;

  try {
    // Use Twilio REST call to create an outbound call
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

    console.log(`[call-lead] Outbound call created for contact ${contact_id}: ${twilioRes.data.sid}`);
    // store minimal mapping (we'll fill more when Twilio hits our webhook)
    callMap[twilioRes.data.sid] = { contact_id, phone, name };

    return res.json({ success: true, callSid: twilioRes.data.sid });
  } catch (err) {
    console.error(`[call-lead] Twilio call error for ${contact_id}:`, err.response?.data || err.message);
    return res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// ---------------- HTTP + WebSocket server ----------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Handle upgrades (Twilio MediaStream will connect via wss://PUBLIC_HOST/stream?callSid=...)
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const callSid = url.searchParams.get('callSid') || 'unknown';
  // Attach leadInfo if available
  const leadInfo = callMap[callSid] || { contact_id: 'unknown' };

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.callSid = callSid;
    ws.leadInfo = leadInfo;
    wss.emit('connection', ws, request);
  });
});

// Helper: create Gemini streaming websocket
function createGeminiWS(onChunk, onClose) {
  // NOTE: You may need to change this to your actual authenticated streaming endpoint.
  // This pattern uses a Google API key appended; if your project requires OAuth you should
  // replace this with a service-account based approach.
  const geminiUrl = `wss://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${GEMINI_API_KEY}`;

  const gws = new WebSocket(geminiUrl, {
    perMessageDeflate: false,
  });

  gws.on('open', () => {
    console.log('[Gemini] connected');
  });

  gws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      // Keep this tolerant — Google often returns nested candidate content
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      if (text) {
        onChunk(text);
      }
    } catch (err) {
      console.error('[Gemini] parse error', err.message);
    }
  });

  gws.on('close', (code, reason) => {
    console.log('[Gemini] closed', code, reason && reason.toString());
    if (onClose) onClose(code, reason);
  });

  gws.on('error', (err) => {
    console.error('[Gemini] error', err.message);
  });

  return gws;
}

// Helper: call ElevenLabs TTS and return raw audio buffer (wav/pcm) as Buffer
async function elevenLabsTTSBuffer(text) {
  if (!ELEVENLABS_KEY) throw new Error('Missing ELEVENLABS_KEY');
  if (!text || text.trim() === '') return null;

  // ElevenLabs TTS streaming endpoint format used here (may need small adjustments per account)
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`;

  const body = {
    text: text,
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.7
    }
  };

  const resp = await axios.post(url, body, {
    headers: {
      'xi-api-key': ELEVENLABS_KEY,
      'Content-Type': 'application/json'
    },
    responseType: 'arraybuffer',
    timeout: 20000
  });

  return Buffer.from(resp.data);
}

// WebSocket connection (from Twilio MediaStream)
wss.on('connection', (ws, req) => {
  const callSid = ws.callSid || 'unknown';
  const lead = ws.leadInfo || { contact_id: 'unknown' };
  console.log(`[WS] MediaStream connected for callSid=${callSid}, lead=${lead.contact_id}`);

  // create Gemini connection per call
  const geminiWS = createGeminiWS(async (replyChunk) => {
    try {
      console.log(`[Gemini->Reply][${lead.contact_id}] chunk:`, replyChunk);

      // Convert Gemini text chunk to audio (ElevenLabs)
      const ttsBuffer = await elevenLabsTTSBuffer(replyChunk);
      if (!ttsBuffer) return;

      // Twilio expects binary audio messages sent to the MediaStream as base64 payloads
      const base64Audio = ttsBuffer.toString('base64');

      // Send media event back to Twilio (this is the format Twilio Media Streams expects for "media" BIN payloads)
      const outbound = {
        event: 'media',
        media: { payload: base64Audio }
      };

      try {
        ws.send(JSON.stringify(outbound));
      } catch (err) {
        console.error('[WS] error sending audio to Twilio:', err.message);
      }
    } catch (err) {
      console.error('[Gemini->ElevenLabs] error:', err.message);
    }
  }, () => {
    // on close
    try { geminiWS.close(); } catch (e) {}
  });

  // buffer transcripts so the conversation retains context
  let transcriptBuffer = '';

  // message handler receives Twilio media events
  ws.on('message', async (msg) => {
    try {
      // Twilio sends JSON frames. Example: { event: 'start' } or { event: 'media', media: { payload: 'base64...' } }
      const data = JSON.parse(msg.toString());

      if (data.event === 'start') {
        console.log(`[WS ${callSid}] Twilio stream started`);
        return;
      }

      if (data.event === 'media' && data.media?.payload) {
        // Twilio provides base64-encoded raw audio (usually mu-law or PCM16 depending on config)
        const audioBase64 = data.media.payload;
        const audioBuffer = Buffer.from(audioBase64, 'base64');

        // Send to DeepGram for transcription
        if (!DG_API_KEY) {
          console.warn('DG_API_KEY not set; skipping ASR');
        } else {
          try {
            const dgResp = await axios.post(
              'https://api.deepgram.com/v1/listen?model=nova&language=en-US',
              audioBuffer,
              {
                headers: {
                  Authorization: `Token ${DG_API_KEY}`,
                  'Content-Type': 'application/octet-stream'
                },
                timeout: 15000
              }
            );

            const transcript = dgResp.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
            if (transcript && transcript.trim() !== '') {
              console.log(`[DeepGram][${lead.contact_id}] transcript:`, transcript);
              // append to buffer for context
              transcriptBuffer += transcript + ' ';

              // Send a user content piece to Gemini streaming WS
              // Format: follow the streaming schema expected by your Gemini endpoint
              if (geminiWS && geminiWS.readyState === WebSocket.OPEN) {
                const payload = {
                  // generative content 'contents' array - minimal user submission
                  contents: [
                    {
                      role: 'user',
                      parts: [{ text: transcript }]
                    }
                  ],
                  // generation parameters (tweak to taste)
                  generationConfig: {
                    maxOutputTokens: 180,
                    temperature: 0.35,
                    topP: 0.9
                  }
                };
                geminiWS.send(JSON.stringify(payload));
              } else {
                console.warn('[Gemini] not open; cannot send transcript');
              }
