require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const axios = require("axios");

const app = express();
const port = process.env.PORT || 10000;

const {
  PUBLIC_HOST,
  DG_API_KEY,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  ELEVENLABS_KEY,
  ELEVENLABS_VOICE
} = process.env;

// GLOBAL DEBUG
const log = (flag, ...args) => console.log(`[${flag}]`, ...args);
process.on("uncaughtException", e => console.error("🔥 UNCAUGHT EXCEPTION", e));
process.on("unhandledRejection", e => console.error("🔥 UNHANDLED PROMISE", e));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health check
app.get("/", (_, res) => res.send("✅ AI Call Server Alive"));
app.get("/health", (_, res) => res.json({ ok: true }));

/* ============================
   TWILIO VOICE WEBHOOK
============================ */
app.post("/twilio-voice-webhook", (req, res) => {
  const callSid = req.body.CallSid || "UNKNOWN";
  log("TWILIO", "Incoming call", callSid);

  const wsUrl = `wss://${PUBLIC_HOST.replace(/^https?:\/\//, "")}/stream`;
  log("TWILIO", "Streaming WebSocket URL:", wsUrl);

  res.type("text/xml").send(`
<Response>
  <Start>
    <Stream url="${wsUrl}" track="both"/>
  </Start>
</Response>
  `);
});

/* ============================
   SERVER + WEBSOCKET
============================ */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/stream")) {
    log("WS", "Upgrade request rejected:", req.url);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => {
    log("WS", "Upgrade OK - new client connected");
    wss.emit("connection", ws);
  });
});

// Helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    log("ELEVENLABS", "TTS buffer received:", r.data.byteLength, "bytes");
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
    ff.on("error", err => {
      console.error("🔥 FFMPEG ERROR", err);
      reject(err);
    });
    ff.on("close", () => {
      log("FFMPEG", "Conversion complete. Total bytes:", Buffer.concat(chunks).length);
      resolve(Buffer.concat(chunks));
    });

    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

/* ============================
   SEND AUDIO TO TWILIO
============================ */
async function sendAudio(ws, buffer) {
  if (!ws.streamSid || ws.readyState !== WebSocket.OPEN || !buffer) {
    log("AUDIO", "Skipped: ws not ready or no buffer");
    return;
  }

  log("AUDIO", "Sending audio...");
  const mulaw = await convertToMulaw(buffer);
  const FRAME = 160; // 20ms

  // Prime with silence
  const silence = Buffer.alloc(FRAME, 0xff);
  for (let i = 0; i < 10; i++) {
    ws.send(JSON.stringify({ event: "media", streamSid: ws.streamSid, media: { payload: silence.toString("base64"), track: "outbound" } }));
    await sleep(25);
  }

  // Send actual audio
  for (let i = 0; i < mulaw.length; i += FRAME) {
    if (ws.readyState !== WebSocket.OPEN) break;
    let chunk = mulaw.slice(i, i + FRAME);
    if (chunk.length < FRAME) chunk = Buffer.concat([chunk, Buffer.alloc(FRAME - chunk.length, 0xff)]);
    ws.send(JSON.stringify({ event: "media", streamSid: ws.streamSid, media: { payload: chunk.toString("base64"), track: "outbound" } }));
    log("AUDIO", "Sent frame", i / FRAME + 1, "/", Math.ceil(mulaw.length / FRAME));
    await sleep(25);
  }
  log("AUDIO", "Completed sending audio. Total bytes:", mulaw.length);
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
      log("WS MSG", data);

      if (data.event === "start") {
        ws.streamSid = data.start?.streamSid;
        log("TWILIO", "Stream started", ws.streamSid);
        if (!ws.streamSid) return console.error("❌ Missing streamSid!");

        // Send initial greeting
        aiSpeaking = true;
        const greetingBuffer = await tts("Hello! I'm ready to chat with you.");
        if (greetingBuffer) await sendAudio(ws, greetingBuffer);
        aiSpeaking = false;
      }

      if (data.event === "media" && !aiSpeaking && dg.readyState === WebSocket.OPEN) {
        log("WS MEDIA", "Sending audio to DeepGram:", data.media?.payload?.length || 0, "bytes");
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
server.listen(port, () => console.log(`✅ Server listening on ${port}`));
