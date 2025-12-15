require("dotenv").config();

/* ========================
   GLOBAL DEBUG
======================== */
process.on("uncaughtException", e => console.error("🔥 UNCAUGHT EXCEPTION", e));
process.on("unhandledRejection", e => console.error("🔥 UNHANDLED PROMISE", e));

const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const axios = require("axios");

const app = express();
const port = process.env.PORT || 10000;

/* ========================
   ENV
======================== */
const {
  PUBLIC_HOST,
  DG_API_KEY,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  ELEVENLABS_KEY,
  ELEVENLABS_VOICE
} = process.env;

console.log("🚀 SERVER BOOTING");
console.log("🌐 PUBLIC_HOST:", PUBLIC_HOST);
console.log("🤖 GEMINI_MODEL:", GEMINI_MODEL);
console.log("🔊 ELEVENLABS_VOICE:", ELEVENLABS_VOICE);

/* ========================
   EXPRESS
======================== */
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const log = (flag, ...args) => console.log(`[${flag}]`, ...args);

/* ========================
   HEALTH
======================== */
app.get("/", (_, res) => res.send("✅ AI Call Server Alive"));
app.get("/health", (_, res) => res.json({ ok: true }));

/* ========================
   TWILIO WEBHOOK
======================== */
app.post("/twilio-voice-webhook", (req, res) => {
  log("TWILIO", "Incoming call", req.body.CallSid);

  const wsUrl = `wss://${PUBLIC_HOST.replace(/^https?:\/\//, "")}/stream`;

  // Return TwiML that answers the call first, then starts the stream
  res.type("text/xml").send(`
<Response>
  <Answer/>
  <Start>
    <Stream url="${wsUrl}" track="both" />
  </Start>
</Response>
  `);
});


/* ========================
   SERVER + WS
======================== */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/stream")) return socket.destroy();

  wss.handleUpgrade(req, socket, head, ws => {
    log("WS", "Upgrade OK");
    wss.emit("connection", ws);
  });
});

/* ========================
   HELPERS
======================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ========================
   GEMINI
======================== */
async function callGemini(text) {
  log("GEMINI", "Prompt:", text);
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`,
    { contents: [{ role: "user", parts: [{ text }] }] },
    { params: { key: GEMINI_API_KEY } }
  );
  return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

/* ========================
   ELEVENLABS
======================== */
async function tts(text) {
  log("ELEVENLABS", "TTS:", text);
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
    { text },
    { headers: { "xi-api-key": ELEVENLABS_KEY }, responseType: "arraybuffer" }
  );
  return Buffer.from(r.data);
}

/* ========================
   AUDIO CONVERSION
======================== */
function convertToMulaw(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn("C:\\ffmpeg\\bin\\ffmpeg.exe", [
      "-hide_banner",
      "-loglevel", "error",
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

/* ========================
   SEND AUDIO
======================== */
async function sendAudio(ws, mp3Buffer) {
  if (!ws.streamSid || ws.readyState !== WebSocket.OPEN) return;

  const mulaw = await convertToMulaw(mp3Buffer);
  const FRAME = 160; // 20ms @ 8kHz

  log("AUDIO", "Mulaw buffer length:", mulaw.length);

  // 🔑 PRIME WITH SILENCE (15 frames)
  const silence = Buffer.alloc(FRAME, 0xff);
  for (let i = 0; i < 15; i++) {
    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws.streamSid,
      media: { payload: silence.toString("base64"), track: "outbound" }
    }));
    await sleep(25);
  }

  // 🔊 SEND REAL AUDIO
  for (let i = 0; i < mulaw.length; i += FRAME) {
    if (ws.readyState !== WebSocket.OPEN) break;

    let chunk = mulaw.slice(i, i + FRAME);
    // pad last frame if smaller than FRAME
    if (chunk.length < FRAME) {
      const pad = Buffer.alloc(FRAME - chunk.length, 0xff);
      chunk = Buffer.concat([chunk, pad]);
    }

    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws.streamSid,
      media: { payload: chunk.toString("base64"), track: "outbound" }
    }));

    log("WS AUDIO FRAME", `Sent frame ${Math.floor(i / FRAME) + 1}, size: ${chunk.length}`);
    await sleep(25);
  }

  log("AUDIO", "Total audio bytes sent:", mulaw.length);
}

/* ========================
   WS HANDLER
======================== */
wss.on("connection", ws => {
  log("WS", "Connected");

  let aiSpeaking = false;

  const dg = new WebSocket(
    "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&endpointing=true",
    { headers: { Authorization: `Token ${DG_API_KEY}` } }
  );

  dg.on("open", () => log("DEEPGRAM", "Connected"));

  ws.on("message", async msg => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      ws.streamSid = data.start.streamSid;
      log("TWILIO", "Stream started", ws.streamSid);

      // 🔊 Send a welcome greeting via ElevenLabs
      aiSpeaking = true;
      const greetingBuffer = await tts("Hello! Yes, I'm here and ready to chat. How can I help you today?");
      await sendAudio(ws, greetingBuffer);
      aiSpeaking = false;
    }

    if (data.event === "media" && dg.readyState === WebSocket.OPEN && !aiSpeaking) {
      dg.send(Buffer.from(data.media.payload, "base64"));
    }
  });

  dg.on("message", async msg => {
    const data = JSON.parse(msg.toString());
    if (!data.is_final) return;

    const transcript = data.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) return;

    log("DEEPGRAM", "FINAL:", transcript);

    aiSpeaking = true;
    const reply = await callGemini(transcript);
    if (reply) {
      const replyBuffer = await tts(reply);
      await sendAudio(ws, replyBuffer);
    }
    aiSpeaking = false;
  });

  ws.on("close", () => {
    log("WS", "Closed");
    dg.close();
  });
});


/* ========================
   START SERVER
======================== */
server.listen(port, () => {
  console.log(`✅ Server listening on ${port}`);
});
