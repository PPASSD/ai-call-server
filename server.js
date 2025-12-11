// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const { Buffer } = require('buffer');

const app = express();
const port = process.env.PORT || 10000;
const PUBLIC_HOST = process.env.PUBLIC_HOST; // e.g., your Render URL without protocol

app.use(bodyParser.json());

// Map CallSid -> lead info
const callMap = {};

// =================== Twilio Voice Webhook ===================
app.post('/twilio-voice-webhook', (req, res) => {
  const { contact_id, phone, name, CallSid } = req.body;

  if (CallSid && contact_id) {
    callMap[CallSid] = { contact_id, phone, name };
    console.log(`[Lead ${contact_id}] Twilio webhook received. CallSid: ${CallSid}`);
  } else {
    console.log(`[Lead unknown] Twilio webhook received without lead info`);
  }

  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${PUBLIC_HOST}/stream?callSid=${CallSid}" />
      </Start>
      <Say>Hello, this is your AI assistant.</Say>
    </Response>
  `;
  res.type('text/xml');
  res.send(twiml);
});

// =================== HTTP + WebSocket Setup ===================
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Upgrade HTTP -> WS
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const callSid = url.searchParams.get('callSid');
  const leadInfo = callMap[callSid] || { contact_id: 'unknown' };

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.leadInfo = leadInfo;
    ws.callSid = callSid;
    wss.emit('connection', ws, request);
  });
});

// =================== Real-time Streaming ===================
wss.on('connection', async (ws) => {
  console.log(`[Lead ${ws.leadInfo.contact_id}] MediaStream connected`);

  let transcriptBuffer = '';

  // ---------------- Gemini 2.5 Flashlight ----------------
  const geminiWS = new WebSocket('wss://api.gemini.ai/flashlight/v2.5/stream', {
    headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}` },
  });

  geminiWS.on('open', () => console.log(`[Lead ${ws.leadInfo.contact_id}] Connected to Gemini 2.5`));
  geminiWS.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.text) {
        // ---------------- ElevenLabs TTS ----------------
        const ttsResponse = await axios.post(
          'https://api.elevenlabs.io/v1/text-to-speech/alloy/stream',
          { text: data.text },
          {
            headers: { 'xi-api-key': process.env.ELEVENLABS_KEY },
            responseType: 'arraybuffer',
          }
        );
        // Send audio chunks back to Twilio
        ws.send(Buffer.from(ttsResponse.data));
      }
    } catch (err) {
      console.error(`[Lead ${ws.leadInfo.contact_id}] Gemini/ElevenLabs error:`, err.message);
    }
  });

  // ---------------- Handle Twilio Audio ----------------
  ws.on('message', async (message) => {
    try {
      // Twilio MediaStream sends JSON with base64 PCM16 in event.media.payload
      const payload = JSON.parse(message.toString());

      if (payload.event === 'media' && payload.media?.payload) {
        const audioBuffer = Buffer.from(payload.media.payload, 'base64');

        // ---------------- DeepGram ASR ----------------
        const dgResponse = await axios.post(
          'https://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000',
          audioBuffer,
          {
            headers: {
              Authorization: `Token ${process.env.DG_API_KEY}`,
              'Content-Type': 'application/octet-stream',
            },
          }
        );

        const transcript = dgResponse.data?.results?.channels[0]?.alternatives[0]?.transcript || '';
        transcriptBuffer += transcript + ' ';
        console.log(`[Lead ${ws.leadInfo.contact_id}] DeepGram transcript:`, transcript);

        // ---------------- Send transcript to Gemini ----------------
        if (geminiWS.readyState === WebSocket.OPEN) {
          geminiWS.send(JSON.stringify({ prompt: transcriptBuffer, stream: true }));
        }
      }
    } catch (err) {
      console.error(`[Lead ${ws.leadInfo.contact_id}] Audio handling error:`, err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[Lead ${ws.leadInfo.contact_id}] MediaStream disconnected`);
    if (ws.callSid) delete callMap[ws.callSid];
    if (geminiWS.readyState === WebSocket.OPEN) geminiWS.close();
  });
});

// =================== Outbound Call Endpoint ===================
app.post('/call-lead', async (req, res) => {
  const { phone, name, contact_id } = req.body;

  try {
    const params = new URLSearchParams({
      To: phone,
      From: process.env.TWILIO_NUMBER,
      Url: `https://${PUBLIC_HOST}/twilio-voice-webhook`,
    });

    const callResponse = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Calls.json`,
      params,
      {
        auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_AUTH_TOKEN },
      }
    );

    console.log(`[Lead ${contact_id}] Outbound call started: ${callResponse.data.sid}`);
    res.json({ success: true, callSid: callResponse.data.sid });
  } catch (err) {
    console.error(`[Lead ${contact_id}] Twilio call error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =================== Start Server ===================
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
