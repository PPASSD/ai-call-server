// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const http = require('http');
const twilio = require('twilio');
const fetch = require('node-fetch'); // for ElevenLabs API

const app = express();
const port = process.env.PORT || 10000;

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(bodyParser.json());

// Map to track CallSid -> leadId
const callMap = {};

// ========== 1. Endpoint to trigger outbound call ==========
app.post('/call-lead', async (req, res) => {
  const { phone, contact_id, name } = req.body;

  try {
    const call = await client.calls.create({
      to: phone,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.SERVER_URL}/twilio-voice-webhook?contact_id=${contact_id}&name=${encodeURIComponent(name)}`
    });

    callMap[call.sid] = contact_id;
    console.log(`[Lead ${contact_id}] Outbound call started: ${call.sid}`);
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error(`[Lead ${contact_id}] Error starting call:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== 2. Twilio Voice Webhook (TwiML) ==========
app.post('/twilio-voice-webhook', (req, res) => {
  const { contact_id, name } = req.query;
  const CallSid = req.body.CallSid || req.query.CallSid;

  if (CallSid && contact_id) callMap[CallSid] = contact_id;

  console.log(`[Lead ${contact_id || 'unknown'}] Twilio webhook invoked. CallSid: ${CallSid}`);

  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/stream?callSid=${CallSid}" />
      </Start>
      <Say>Hello, this is your AI assistant. Please wait while I connect.</Say>
    </Response>
  `;

  res.type('text/xml');
  res.send(twiml);
});

// ========== 3. HTTP + WebSocket Setup ==========
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Upgrade HTTP to WS
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

// ========== 4. Handle Twilio MediaStream ==========
wss.on('connection', (ws) => {
  console.log(`[Lead ${ws.leadId}] Twilio MediaStream connected`);

  ws.on('message', async (message) => {
    // Log audio chunk size
    console.log(`[Lead ${ws.leadId}] Audio chunk received: ${message.length} bytes`);

    // TODO: Send audio to DeepGram WebSocket
    // Placeholder: transcribe audio
    // const transcription = await sendAudioToDeepGram(message);

    // TODO: Generate AI response
    // const aiResponse = await generateAIResponse(transcription);

    // TODO: Send AI response to ElevenLabs TTS
    // const ttsAudio = await elevenLabsTTS(aiResponse);

    // TODO: Send TTS back to Twilio call
    // ws.send(ttsAudio);
  });

  ws.on('close', () => {
    console.log(`[Lead ${ws.leadId}] Twilio MediaStream disconnected`);
    if (ws.callSid) delete callMap[ws.callSid];
  });
});

// ========== 5. Placeholder functions for DeepGram & ElevenLabs ==========
async function sendAudioToDeepGram(audioBuffer) {
  // Implement DeepGram streaming API
}

async function generateAIResponse(transcription) {
  // Implement AI model (OpenAI GPT) response
}

async function elevenLabsTTS(text) {
  // Implement TTS using ElevenLabs API
}

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
