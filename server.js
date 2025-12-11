// server.js -- minimal AI call server for Render with DeepGram
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Twilio = require('twilio');
const { WebSocketServer } = require('ws');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

// 1) Endpoint for GoHighLevel to start outbound call
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

// 2) Twilio voice webhook
app.post('/twilio/voice', (req, res) => {
  const leadId = req.query.leadId || '';
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

// 3) WebSocket server for Twilio MediaStream
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  console.log('WebSocket: Twilio MediaStream connected');
  const params = new URLSearchParams(req.url.replace(/^\/stream\?/, ''));
  const leadId = params.get('leadId') || '';

  // Connect to DeepGram
  const dgWs = new WebSocket('wss://api.deepgram.com/v1/listen?punctuate=true', {
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`
    }
  });

  dgWs.on('open', () => console.log(`Connected to DeepGram for lead ${leadId}`));
  dgWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.channel && data.channel.alternatives) {
        const transcript = data.channel.alternatives[0].transcript;
        if (transcript && transcript.length > 0) {
          console.log(`Lead ${leadId} transcript: ${transcript}`);
        }
      }
    } catch (err) {
      console.error('DeepGram parse error:', err);
    }
  });

  dgWs.on('close', () => console.log(`DeepGram WebSocket closed for lead ${leadId}`));
  dgWs.on('error', (err) => console.error('DeepGram error:', err));

  // Handle Twilio messages
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'media') {
        const payload = data.media.payload;
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(Buffer.from(payload, 'base64'));
        }
      }
    } catch (e) {
      console.debug('ws parse error', e);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket: Twilio MediaStream disconnected');
    if (dgWs && dgWs.readyState === WebSocket.OPEN) dgWs.close();
  });
});
