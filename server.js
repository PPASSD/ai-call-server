// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const port = process.env.PORT || 10000;

app.use(bodyParser.json());

// Map to track CallSid -> leadId
const callMap = {};

// Twilio Voice webhook: receive outbound call request from GoHighLevel
app.post('/twilio-voice-webhook', (req, res) => {
  const { contact_id, phone, name, CallSid } = req.body;

  // Store mapping
  if (CallSid && contact_id) {
    callMap[CallSid] = contact_id;
    console.log(`[Lead ${contact_id}] Twilio voice webhook received. CallSid: ${CallSid}`);
  } else {
    console.log(`[Lead unknown] Twilio voice webhook received without lead info`);
  }

  // Respond with TwiML
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

// Create HTTP server and WebSocket server
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

// Handle incoming WebSocket connections (Twilio MediaStream)
wss.on('connection', (ws) => {
  console.log(`[Lead ${ws.leadId}] Twilio MediaStream connected`);

  ws.on('message', (message) => {
    // For simplicity, log the size of audio chunks
    console.log(`[Lead ${ws.leadId}] Sending audio to DeepGram: ${message.length} bytes`);

    // TODO: Send audio to DeepGram WebSocket here
    // TODO: Receive AI response and send to ElevenLabs TTS if needed
  });

  ws.on('close', () => {
    console.log(`[Lead ${ws.leadId}] Twilio MediaStream disconnected`);
    // Cleanup mapping
    if (ws.callSid) delete callMap[ws.callSid];
  });
});

// Start server
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
