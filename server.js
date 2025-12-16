require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const axios = require("axios");
const twilioClient = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app = express();
const port = process.env.PORT || 10000;

const {
  PUBLIC_HOST,
  DG_API_KEY,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  ELEVENLABS_KEY,
  ELEVENLABS_VOICE,
  DEFAULT_PHONE,
  TWILIO_NUMBER
} = process.env;

// Simple logger
const DEBUG = true;
const log = (flag, ...args) => {
  if (DEBUG) console.log(`[${flag}]`, ...args);
};

// Body parsing
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health check
app.get("/", (_, res) => res.send("✅ AI Call Server Alive"));
app.get("/health", (_, res) => res.json({ ok: true }));

/* ============================
   GO HIGH LEVEL WEBHOOK
   Receives JSON, triggers Twilio call
============================ */
app.post("/go-highlevel-webhook", async (req, res) => {
  const phone = req.body.contact?.phone;
  if (!phone) {
    log("GHL", "No phone provided in webhook payload");
    return res.status(400).send("No phone provided");
  }

  log("GHL", "Webhook received for", phone);

  try {
    const call = await twilioClient.calls.create({
      to: phone,
      from: TWILIO_NUMBER || DEFAULT_PHONE,
      url: `https://${PUBLIC_HOST}/twilio-voice-webhook` // AI stream attaches here
    });

    log("TWILIO", "Call initiated", call.sid);
    res.sendStatus(200);
  } catch (err) {
    console.error("🔥 TWILIO CALL ERROR", err);
    res.status(500).send(err.message);
  }
});

/* ============================
   TWILIO VOICE WEBHOOK
   Handles AI streaming when call is answered
============================ */
app.post("/twilio-voice-webhook", (req, res) => {
  const callSid = req.body.CallSid || "UNKNOWN";
  log("TWILIO", "Incoming call answered", callSid);

  const wsUrl = `wss://${PUBLIC_HOST.replace(/^https?:\/\//, "")}/stream`;

  // TwiML: attach AI stream to the call
  res.type("text/xml").send(`
<Response>
  <Start>
    <Stream url="${wsUrl}" track="both"/>
  </Start>
  <Pause length="30"/>
</Response>
  `);
});

/* Optional endpoint to log when Dial completes */
app.post("/twilio-dial-complete", (req, res) => {
  log("TWILIO", "Dial completed", req.body);
  res.sendStatus(200);
});

/* ============================
   SERVER + WEBSOCKET
============================ */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/stream")) {
    log("WS", "Rejected upgrade request:", req.url);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => {
    log("WS", "Upgrade OK - new client connected");
    wss.emit("connection", ws);
  });
});

// Helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================
   ELEVENLABS TTS
============================ */
async function tts(text) {
  try {
    log("ELEVENLABS", "TTS text:", text);
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
      { text, model_id: "eleven_monolingual_v1" },
      { headers: { "xi-api-key": ELEVENLABS_KEY }, responseType: "arraybuffer" }
    );
    return Buffer.from(r.data);
  } catch (err) {
    console.error("🔥 ELEVENLABS ERROR", err.response?.data || err.message);
    return null;
  }
}

/* ============================
   CONVERT AUDIO TO MULAW
============================ */
function convertToMulaw(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-ac", "1",
      "-ar", "8000",
      "-acodec", "pcm_mulaw",
      "-f", "mulaw",
      "pipe:1"
    ]);

    const chunks = [];
    ff.stdout.on("data", d => chunks.push(d));
    ff.stderr.on("data", e => console.error("[FFMPEG]", e.toString()));
    ff.on("error", reject);
    ff.on("close", () => resolve(Buffer.concat(chunks)));

    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

/* ============================
   SEND AUDIO TO TWILIO
============================ */
async function sendAudio(ws, buffer) {
  if (!ws.streamSid || ws.readyState !== WebSocket.OPEN || !buffer) {
    log("AUDIO", "Skipped: ws not ready or buffer missing");
    return;
  }

  const mulaw = await convertToMulaw(buffer);
  const FRAME = 160; // 20ms @ 8kHz
  const silence = Buffer.alloc(FRAME, 0xff);

  for (let i = 0; i < 5; i++) {
    ws.send(JSON.stringify({ event: "media", streamSid: ws.streamSid, media: { payload: silence.toString("base64"), track: "outbound" } }));
    await sleep(20);
  }

  for (let i = 0; i < mulaw.length; i += FRAME) {
    if (ws.readyState !== WebSocket.OPEN) break;
    let chunk = mulaw.slice(i, i + FRAME);
    if (chunk.length < FRAME) chunk = Buffer.concat([chunk, Buffer.alloc(FRAME - chunk.length, 0xff)]);
    ws.send(JSON.stringify({ event: "media", streamSid: ws.streamSid, media: { payload: chunk.toString("base64"), track: "outbound" } }));
    await sleep(20);
  }

  log("AUDIO", `Sent ${Math.ceil(mulaw.length / FRAME)} frames`);
}

/* ============================
   GEMINI AI
============================ */
async function callGemini(text) {
  try {
    log("GEMINI", "Prompt:", text);
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`,
      { contents: [{ role: "user", parts: [{ text }] }] },
      { params: { key: GEMINI_API_KEY } }
    );
    const reply = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    log("GEMINI", "Reply:", reply);
    return reply;
  } catch (err) {
    console.error("🔥 GEMINI ERROR", err.response?.data || err.message);
    return null;
  }
}

/* ============================
   WEBSOCKET HANDLER
============================ */
wss.on("connection", ws => {
  log("WS", "Client connected");
  let aiSpeaking = false;

  const dg = new WebSocket(
    "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&endpointing=true",
    { headers: { Authorization: `Token ${DG_API_KEY}` } }
  );

  dg.on("open", () => log("DEEPGRAM", "Connected"));
  dg.on("close", () => log("DEEPGRAM", "Connection closed"));
  dg.on("error", err => console.error("🔥 DEEPGRAM ERROR", err));

  ws.on("message", async msg => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") {
        ws.streamSid = data.start?.streamSid;
        log("TWILIO", "Stream started", ws.streamSid);

        aiSpeaking = true;
        const greeting = await tts("Hello! I am ready to chat.");
        if (greeting) await sendAudio(ws, greeting);
        aiSpeaking = false;
      }

      if (data.event === "media" && !aiSpeaking && dg.readyState === WebSocket.OPEN) {
        dg.send(Buffer.from(data.media.payload, "base64"));
      }
    } catch (err) {
      console.error("🔥 WS MESSAGE ERROR", err);
    }
  });

  dg.on("message", async msg => {
    try {
      const data = JSON.parse(msg.toString());
      if (!data.is_final) return;
      const transcript = data.channel?.alternatives?.[0]?.transcript?.trim();
      if (!transcript) return;
      log("DEEPGRAM", "FINAL transcript:", transcript);

      aiSpeaking = true;
      const reply = await callGemini(transcript);
      if (reply) {
        const replyBuffer = await tts(reply);
        if (replyBuffer) await sendAudio(ws, replyBuffer);
      }
      aiSpeaking = false;
    } catch (err) {
      console.error("🔥 DEEPGRAM MESSAGE ERROR", err);
    }
  });

  ws.on("close", () => {
    log("WS", "Client disconnected");
    dg.close();
  });

  ws.on("error", err => console.error("🔥 WS ERROR", err));
});

/* ============================
   START SERVER
============================ */
server.listen(port, () => log("SERVER", `Listening on ${port}`));
