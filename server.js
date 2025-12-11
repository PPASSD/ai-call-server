// server.js -- minimal AI call server for Render with DeepGram

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Twilio = require('twilio');
const { WebSocketServer } = require('ws');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --------------------
// Environment Variables
// --------------------
const PORT = process.env.PORT || 10000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const BASE_URL = process.env.BASE_URL;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !BASE_URL || !DEEPGRAM_API_KEY) {
  console.warn('Missing required env vars. See README and .env.example.');
}

const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const WebSocket = require('ws');

// --------------------
// Logging helper
// --------------------
function logLead(leadId, message) {
  console.log(`[${new Date().toISOString()}][Lead ${leadId || 'unknown'}] ${message}`);
}

// --------------------
// 1) Endpoint for GoHighLevel to start outbound call
// --------------------
app.post('/start-call', async (req, res) => {
  try {
    const { phone, contact_id } = req.body;  // use contact_id from GHL webhook
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const call = await twilioClient.calls.create({
      to: phone,
      from: TWILIO_FROM_NUMBER,
      url: `${BASE_URL}/twilio/voice?leadId=${encodeURIComponent(contact_id || '')}`
    });

    logLead(contact_id, `Outbound call started (Call SID: ${call.sid})`);
    return res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('start-call error', err);
    return res.status(500).json({ error: String(err) });
  }
});

// --------------------
// 2) Twilio voice webhook
// --------------------
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
  logLead(leadId, 'Twilio voice webhook responded');
});

// --------------------
// 3) WebSocket server for Twilio MediaStream
// --------------------
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
      console.error(`[Lead ${leadId}] DeepGram parse error:`, err);
    }
  });

  dgWs.on('close', () => logLead(leadId, 'DeepGram WebSocket closed'));
  dgWs.on('error', (err) => console.error(`[Lead ${leadId}] DeepGram error:`, err));

  // Handle Twilio MediaStream messages
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'media' && dgWs.readyState === WebSocket.OPEN) {
        const payload = Buffer.from(data.media.payload, 'base64');
        dgWs.send(payload);
        logLead(leadId, `Sending audio to DeepGram: ${payload.length} bytes`);
      }
    } catch (err) {
      console.debug(`[Lead ${leadId}] WS parse error:`, err);
    }
  });

  ws.on('close', () => {
    logLead(leadId, 'Twilio MediaStream disconnected');
    if (dgWs && dgWs.readyState === WebSocket.OPEN) dgWs.close();
  });
});
