// server.js -- AI call server for Render with DeepGram logging
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Twilio = require('twilio');
const { WebSocketServer } = require('ws');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------- Environment Variables --------------------
const PORT = process.env.PORT || 10000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const BASE_URL = process.env.BASE_URL;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// -------------------- Helper Logging Function --------------------
function logLead(leadId, message) {
  console.log(`[${new Date().toISOString()}][Lead ${leadId}] ${message}`);
}

// -------------------- Check Env --------------------
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !BASE_URL || !DEEPGRAM_API_KEY) {
  console.warn('Missing required env vars. See README and .env.example.');
}

// -------------------- Twilio Client --------------------
const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const WebSocket = require('ws');

// -------------------- 1) GoHighLevel Outbound Call Endpoint --------------------
app.post('/start-call', async (req, res) => {
  try {
    const { phone, leadId } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const call = await twilioClient.calls.create({
      to: phone,
      from: TWILIO_FROM_NUMBER,
      url: `${BASE_URL}/twilio/voice?leadId=${encodeURIComponent(leadId || '')}`
    });

    return res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('start-call error', err);
    return res.status(500).json({ error: String(err) });
  }
});

// -------------------- 2) Twilio Voice Webhook --------------------
app.post('/twilio/voice', (req, res) => {
  const leadId = req.query.leadId || 'unknown';
  const streamUrl = (BASE_URL.replace(/^http/, 'ws')) + '/stream?leadId=' + encodeURIComponent(leadId);

  const twiml = `
  <Response>
    <Start>
      <Stream url="${streamUrl}" />
    </Start>
    <Say voice="alice">Connecting you to our assistant. Please hold.</Say>
    <Pause length="1"/>
    <Say voice="alice">You are now connected.</Say>
  </Response>`;

  res.type('text/xml').send(twiml);
});

// -------------------- 3) WebSocket Server for Twilio MediaStream --------------------
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace(/^\/stream\?/, ''));
  const leadId = params.get('leadId') || 'unknown';

  logLead(leadId, 'Twilio MediaStream connected');

  // Connect to DeepGram
  const dgWs = new WebSocket('wss://api.deepgram.com/v1/listen?punctuate=true', {
    headers: { 'Authorization': `Token ${DEEPGRAM_API_KEY}` }
  });

  dgWs.on('open', () => logLead(leadId, 'Connected to DeepGram'));
  dgWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.channel && data.channel.alternatives) {
        const transcript = data.channel.alternatives[0].transcript;
        if (transcript && transcript.length > 0) {
          logLead(leadId, `Transcript: ${transcript}`);
        }
      }
    } catch (err) {
      logLead(leadId, `DeepGram parse error: ${err.message}`);
    }
  });

  dgWs.on('close', () => logLead(leadId, 'DeepGram WebSocket closed'));
  dgWs.on('error', (err) => logLead(leadId, `DeepGram error: ${err.message}`));

  // Handle Twilio messages
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'media') {
        const payload = data.media.payload;
        logLead(leadId, `Sending audio to DeepGram: ${payload.length} bytes`);
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(Buffer.from(payload, 'base64'));
        }
      }
    } catch (e) {
      logLead(leadId, `ws parse error: ${e.message}`);
    }
  });

  ws.on('close', () => {
    logLead(leadId, 'Twilio MediaStream disconnected');
    if (dgWs && dgWs.readyState === WebSocket.OPEN) dgWs.close();
  });
});
