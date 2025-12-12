// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;

// ========================
// ENV Variables
// ========================
const PUBLIC_HOST = process.env.PUBLIC_HOST; // Render URL, no https://
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

// ========================
// Express setup
// ========================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------
// Simple Twilio webhook for debugging
// -------------------
app.post('/twilio-voice-webhook', (req, res) => {
  console.log('[twilio-voice-webhook] called, body:', req.body);

  // DEBUG TWIML: simple call
  const twiml = `
    <Response>
      <Say voice="alice">Hello, this is a test call from your Render server. Twilio is working!</Say>
    </Response>
  `;
  res.type('text/xml').send(twiml);
});

// -------------------
// GoHighLevel start-call webhook
// -------------------
app.post('/start-call', async (req, res) => {
  console.log('[start-call] Payload:', req.body);

  const phone = req.body.phone;
  if (!phone) return res.status(400).json({ success: false, error: 'Missing phone number' });

  const twilioWebhookUrl = `https://${PUBLIC_HOST}/twilio-voice-webhook`;

  try {
    const params = new URLSearchParams({ To: phone, From: TWILIO_NUMBER, Url: twilioWebhookUrl });

    const twilioRes = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`,
      params.toString(),
      {
        auth: { username: TWILIO_SID, password: TWILIO_AUTH_TOKEN },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    console.log('[start-call] Twilio call created:', twilioRes.data.sid);
    res.json({ success: true, callSid: twilioRes.data.sid });
  } catch (err) {
    console.error('[start-call] Twilio error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// ========================
// Start server
// ========================
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  console.log(`PUBLIC_HOST: ${PUBLIC_HOST}`);
});
