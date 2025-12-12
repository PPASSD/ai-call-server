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
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

// ========================
// In-memory call map
// ========================
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
// Health check
// -------------------
app.get('/test', (req, res) => {
  res.json({ status: 'Server is running!' });
});

// -------------------
// Twilio Voice Webhook
// -------------------
app.post('/twilio-voice-webhook', (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid || 'unknown';
  const phone = req.query.phone || 'unknown';
  callMap[callSid] = callMap[callSid] || { phone };

  // Minimal TwiML to avoid Twilio errors
  const twiml = `
<Response>
  <Say voice="alice">Hi, connecting you now.</Say>
  <Start>
    <Stream url="wss://${PUBLIC_HOST}/stream?phone=${encodeURIComponent(phone)}&callSid=${callSid}" />
  </Start>
</Response>`;

  console.log('[twilio-voice-webhook] callSid:', callSid, 'phone:', phone);
  res.type('text/xml').send(twiml);
});

// -------------------
// GHL webhook: /start-call
// -------------------
app.post('/start-call', async (req, res) => {
  console.log('[start-call] Payload:', req.body);

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
// Handle WebSocket upgrades only on /stream
// -------------------
server.on('upgrade', (request, socket, head) => {
  if (!request.url.startsWith('/stream')) {
    socket.destroy();
    return;
  }

  const url = new URL(request.url, `https://${request.headers.host}`);
  const callSid = url.searchParams.get('callSid') || 'unknown';
  const phone = url.searchParams.get('phone') || 'unknown';
  const leadInfo = callMap[callSid] || { phone };

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.callSid = callSid;
    ws.phone = phone;
    ws.leadInfo = leadInfo;
    wss.emit('connection', ws, request);
  });
});

// -------------------
// WebSocket Connection Placeholder
// -------------------
wss.on('connection', (ws) => {
  console.log(`[WS] MediaStream connected: callSid=${ws.callSid} phone=${ws.phone}`);

  ws.on('message', (msg) => {
    // For now, just log audio chunks
    const data = JSON.parse(msg.toString());
    if (data.event === 'media') console.log(`[WS][${ws.callSid}] Received audio chunk`);
  });

  ws.on('close', () => {
    console.log(`[WS] Twilio stream closed: ${ws.callSid}`);
    delete callMap[ws.callSid];
  });

  ws.on('error', (err) => console.error(`[WS] error: ${err.message}`));
});

// ========================
// Start Server
// ========================
server.listen(port, () => console.log(`AI Call Server listening on port ${port}`));
