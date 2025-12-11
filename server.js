// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;
app.use(bodyParser.json());

// Track CallSid -> lead info
const callMap = {};

// ======= Twilio Voice Webhook =======
app.post('/twilio-voice-webhook', (req, res) => {
  const { contact_id, phone, name, CallSid } = req.body;

  if (CallSid && contact_id) {
    callMap[CallSid] = contact_id;
    console.log(`[Lead ${contact_id}] Twilio webhook received. CallSid: ${CallSid}`);
  } else {
    console.log(`[Lead unknown] Twilio webhook received without lead info`);
  }

  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/stream?callSid=${CallSid}" />
      </Start>
      <Say>Hello, this is your AI assistant.</Say>
    </Response>
  `;
  res.type('text/xml');
  res.send(twiml);
});

// ======= HTTP + WebSocket Setup =======
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Upgrade HTTP -> WS
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const callSid = url.searchParams.get('callSid');
  const leadId = callMap[callSid] || 'unknown';

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.leadId = leadId;
    ws.callSid = callSid;
    wss.emit('connection', ws, request);
  });
});

// ======= Real-time Streaming Handler =======
wss.on('connection', async (ws) => {
  console.log(`[Lead ${ws.leadId}] Twilio MediaStream connected`);

  let transcriptBuffer = '';

  // Create Gemini WebSocket connection
  const geminiWS = new WebSocket('wss://api.gemini.ai/flashlight/v2.5/stream', {
    headers: {
      'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`,
    },
  });

  geminiWS.on('open', () => console.log(`[Lead ${ws.leadId}] Connected to Gemini 2.5`));
  geminiWS.on('message', async (msg) => {
    const data = JSON.parse(msg);
    if (data.text) {
      // Send to ElevenLabs TTS
      try {
        const ttsResponse = await axios.post(
          'https://api.elevenlabs.io/v1/stream',
          { text: data.text, voice: 'alloy', format: 'pcm16' },
          { responseType: 'arraybuffer', headers: { 'xi-api-key': process.env.ELEVENLABS_KEY } }
        );

        ws.send(Buffer.from(ttsResponse.data));
      } catch (err) {
        console.error(`[Lead ${ws.leadId}] ElevenLabs TTS error:`, err.message);
      }
    }
  });

  ws.on('message', async (message) => {
    // message = PCM16 audio from Twilio
    console.log(`[Lead ${ws.leadId}] Received audio chunk: ${message.length} bytes`);

    // 1️⃣ Stream audio to DeepGram
    try {
      const dgResponse = await axios.post(
        'https://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000',
        message,
        {
          headers: {
            'Authorization': `Token ${process.env.DG_API_KEY}`,
            'Content-Type': 'application/octet-stream',
          },
        }
      );

      const transcript = dgResponse.data?.results?.channels[0]?.alternatives[0]?.transcript || '';
      transcriptBuffer += transcript + ' ';
      console.log(`[Lead ${ws.leadId}] DeepGram transcript: ${transcript}`);

      // 2️⃣ Send partial transcript to Gemini WebSocket
      if (geminiWS.readyState === WebSocket.OPEN) {
        geminiWS.send(JSON.stringify({ prompt: transcriptBuffer, stream: true }));
      }
    } catch (err) {
      console.error(`[Lead ${ws.leadId}] DeepGram error:`, err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[Lead ${ws.leadId}] Twilio MediaStream disconnected`);
    if (ws.callSid) delete callMap[ws.callSid];
    geminiWS.close();
  });
});

// ======= Endpoint to initiate call =======
app.post('/call-lead', async (req, res) => {
  const { phone, name, contact_id } = req.body;

  try {
    const callResponse = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Calls.json`,
      new URLSearchParams({
        To: phone,
        From: process.env.TWILIO_NUMBER,
        Url: `https://${req.headers.host}/twilio-voice-webhook`,
      }),
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

// ======= Start server =======
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
