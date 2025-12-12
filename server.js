// server.js - Minimal Working AI Call Server (Twilio -> DeepGram)
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
  if (s.startsWith('{{') && s.endsWith('}}')) return null;
  s = s.replace(/\D/g, '');
  if (s.length === 10) s = '1' + s;
  if (s.length === 11 && s.startsWith('1')) return '+' + s;
  return '+' + s;
}

// -------------------
// Twilio Voice Webhook
// -------------------
app.post('/twilio-voice-webhook', (req, res) => {
  const CallSid = req.body.CallSid || req.body.callSid;
  const contact_id = req.query.contact_id || 'unknown';
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

// -------------------
// GHL webhook: /call-lead
// -------------------
app.post('/call-lead', async (req, res) => {
  console.log('[call-lead] Incoming payload:', req.body);
  const phone = sanitizePhone(req.body.phone);
  const name = req.body.name || 'Unknown';
  const contact_id = req.body.contact_id || 'unknown';

  if (!phone) return res.status(400).json({ success: false, error: 'Invalid phone' });

  const twilioWebhookUrl = `https://${PUBLIC_HOST}/twilio-voice-webhook?contact_id=${encodeURIComponent(contact_id)}`;
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
    callMap[twilioRes.data.sid] = { contact_id, phone, name };
    console.log(`[call-lead] Call created: ${twilioRes.data.sid}`);
    res.json({ success: true, callSid: twilioRes.data.sid });
  } catch (err) {
    console.error('[call-lead] Twilio error:', err.response?.data || err.message);
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
  const callSid = url.searchParams.get('callSid') || 'unknown';
  const leadInfo = callMap[callSid] || { contact_id: 'unknown' };

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.callSid = callSid;
    ws.leadInfo = leadInfo;
    wss.emit('connection', ws, request);
  });
});

// -------------------
// WebSocket: Twilio MediaStream -> DeepGram
// -------------------
wss.on('connection', (ws) => {
  const callSid = ws.callSid;
  const lead = ws.leadInfo;
  console.log(`[WS] MediaStream connected: callSid=${callSid}`);

  // DeepGram WS
  const dgWS = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova&language=en-US', {
    headers: { Authorization: `Token ${DG_API_KEY}` }
  });

  dgWS.on('open', () => console.log(`[DeepGram] WS open for callSid=${callSid}`));

  dgWS.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'transcript') {
        const transcript = data.channel.alternatives[0].transcript;
        if (transcript && transcript.trim() !== '') {
          console.log(`[DeepGram][${callSid}] transcript:`, transcript);
        }
      }
    } catch (err) {
      console.error('[DeepGram WS] parse error', err.message);
    }
  });

  dgWS.on('error', (err) => console.error('[DeepGram WS] error', err.message));
  dgWS.on('close', () => console.log(`[DeepGram] WS closed for callSid=${callSid}`));

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
      console.error(`[WS ${callSid}] parse error:`, err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Twilio stream closed: ${callSid}`);
    if (dgWS.readyState === WebSocket.OPEN) dgWS.close();
    delete callMap[callSid];
  });

  ws.on('error', (err) => console.error(`[WS] error: ${err.message}`));
});

// -------------------
// Start server
// -------------------
server.listen(port, () => console.log(`AI Call Server listening on port ${port}`));
