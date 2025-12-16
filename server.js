require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const axios = require("axios");
const twilioClient = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
const port = process.env.PORT || 10000;

const {
  PUBLIC_HOST,
  DG_API_KEY,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  ELEVENLABS_KEY,
  ELEVENLABS_VOICE,
  TWILIO_NUMBER
} = process.env;

// Simple logger
const DEBUG = true;
const log = (flag, ...args) => {
  if (DEBUG) console.log(`[${flag}]`, ...args);
};

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/", (_, res) => res.send("✅ AI Call Server Alive"));
app.get("/health", (_, res) => res.json({ ok: true }));

/* ============================
   TWILIO WEBHOOKS
============================ */
app.post("/twilio-voice-webhook", async (req, res) => {
  const contact = req.body.contact;

  if (contact && contact.phone) {
    try {
      const call = await twilioClient.calls.create({
        to: contact.phone,
        from: TWILIO_NUMBER,
        url: `https://${PUBLIC_HOST.replace(/^https?:\/\//, "")}/twilio-call-handler`
      });
      log("TWILIO", "Outbound call initiated", call.sid);
      return res.status(200).send({ success: true, callSid: call.sid });
    } catch (err) {
      console.error("🔥 TWILIO CALL ERROR", err.message);
      return res.status(500).send({ error: err.message });
    }
  }

  const wsUrl = `wss://${PUBLIC_HOST.replace(/^https?:\/\//, "")}/stream`;

  res.type("text/xml").send(`
<Response>
  <Start>
    <Stream url="${wsUrl}" track="both"/>
  </Start>
  <Pause length="3600"/>
</Response>
  `);
});

app.post("/twilio-call-handler", (req, res) => {
  const wsUrl = `wss://${PUBLIC_HOST.replace(/^https?:\/\//, "")}/stream`;

  res.type("text/xml").send(`
<Response>
  <Start>
    <Stream url="${wsUrl}" track="both"/>
  </Start>
  <Pause length="3600"/>
</Response>
  `);
});

/* ============================
   SERVER + WS
============================ */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/stream")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    log("WS", "Upgrade OK");
    wss.emit("connection", ws);
  });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================
   AUDIO CONVERSION
============================ */
function convertToMulaw(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-ac", "1",
      "-ar", "8000",
      "-acodec", "pcm_mulaw",
      "-f", "mulaw",
      "pipe:1"
    ]);
    const chunks = [];
    ff.stdout.on("data", d => chunks.push(d));
    ff.on("close", () => resolve(Buffer.concat(chunks)));
    ff.on("error", reject);
    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

/* ============================
   ELEVENLABS TTS
============================ */
async function tts(text) {
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
    { text, model_id: "eleven_monolingual_v1" },
    { headers: { "xi-api-key": ELEVENLABS_KEY }, responseType: "arraybuffer" }
  );

  const tmp = path.join(os.tmpdir(), `tts-${Date.now()}.wav`);
  fs.writeFileSync(tmp, r.data);
  const buffer = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buffer;
}

/* ============================
   SEND AUDIO (FIXED)
============================ */
async function sendAudio(ws, buffer) {
  if (!ws.readyForAudio || ws.readyState !== WebSocket.OPEN) {
    log("AUDIO", "Twilio not ready — skipping");
    return;
  }

  const mulaw = await convertToMulaw(buffer);
  const FRAME = 160;

  for (let i = 0; i < mulaw.length; i += FRAME) {
    const chunk = mulaw.slice(i, i + FRAME);
    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws.streamSid,
      media: { payload: chunk.toString("base64"), track: "outbound" }
    }));
    await sleep(20);
  }

  log("AUDIO", `Sent ${Math.ceil(mulaw.length / FRAME)} frames`);
}

/* ============================
   GEMINI
============================ */
async function callGemini(text) {
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`,
    { contents: [{ role: "user", parts: [{ text }] }] },
    { params: { key: GEMINI_API_KEY } }
  );
  return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

/* ============================
   WS HANDLER (FIXED)
============================ */
wss.on("connection", ws => {
  ws.readyForAudio = false;

  const dg = new WebSocket(
    "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000",
    { headers: { Authorization: `Token ${DG_API_KEY}` } }
  );

  ws.on("message", async msg => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      ws.streamSid = data.start.streamSid;
      log("TWILIO", "Stream started", ws.streamSid);

      // 🔑 PRIME OUTBOUND AUDIO IMMEDIATELY
      const silence = Buffer.alloc(160, 0xff);
      for (let i = 0; i < 10; i++) {
        ws.send(JSON.stringify({
          event: "media",
          streamSid: ws.streamSid,
          media: { payload: silence.toString("base64"), track: "outbound" }
        }));
      }

      // 🔑 GIVE TWILIO TIME TO OPEN AUDIO PATH
      setTimeout(() => {
        ws.readyForAudio = true;
        log("AUDIO", "Twilio ready for outbound audio");
      }, 500);
    }

    if (data.event === "media") {
      dg.send(Buffer.from(data.media.payload, "base64"));
    }
  });

  dg.on("message", async msg => {
    const data = JSON.parse(msg.toString());
    if (!data.is_final) return;
    const transcript = data.channel.alternatives[0].transcript.trim();
    if (!transcript) return;

    log("DEEPGRAM", transcript);
    const reply = await callGemini(transcript);
    if (!reply) return;

    const audio = await tts(reply);
    await sendAudio(ws, audio);
  });

  ws.on("close", () => dg.close());
});

/* ============================
   START
============================ */
server.listen(port, () => log("SERVER", `Listening on ${port}`));
