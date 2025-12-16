require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const axios = require("axios");
const twilioClient = require("twilio")(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const fs = require("fs");
const os = require("os");
const path = require("path");
const mime = require("mime"); // added to set proper Content-Type for static files

const app = express();
const port = process.env.PORT || 10000;

let {
  PUBLIC_HOST,
  DG_API_KEY,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  ELEVENLABS_KEY,
  ELEVENLABS_VOICE,
  TWILIO_NUMBER
} = process.env;

// Normalize PUBLIC_HOST to avoid double https://
PUBLIC_HOST = (PUBLIC_HOST || "").replace(/^https?:\/\//, "");

// Simple logger
const DEBUG = true;
const log = (flag, ...args) => {
  if (DEBUG) console.log(`[${flag}]`, ...args);
};

// Body parser
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files (for silence.mp3) with correct Content-Type
app.use("/public", express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    const type = mime.getType(filePath);
    if (type) res.setHeader("Content-Type", type);
  }
}));

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
        url: `https://${PUBLIC_HOST}/twilio-call-handler` // safe now
      });
      log("TWILIO", "Outbound call initiated", call.sid);
      return res.status(200).send({ success: true, callSid: call.sid });
    } catch (err) {
      console.error("🔥 TWILIO CALL ERROR", err.message);
      return res.status(500).send({ error: err.message });
    }
  }

  const wsUrl = `wss://${PUBLIC_HOST}/stream`;
  const silenceUrl = `https://${PUBLIC_HOST}/public/silence.mp3`;

  // Return TwiML with proper Content-Type
  res.type("text/xml").send(`
<Response>
  <Start>
    <Stream url="${wsUrl}" track="both"/>
  </Start>
  <Play>${silenceUrl}</Play>
</Response>
  `);
});

app.post("/twilio-call-handler", (req, res) => {
  const wsUrl = `wss://${PUBLIC_HOST}/stream`;
  const silenceUrl = `https://${PUBLIC_HOST}/public/silence.mp3`;

  // Return TwiML with proper Content-Type
  res.type("text/xml").send(`
<Response>
  <Start>
    <Stream url="${wsUrl}" track="both"/>
  </Start>
  <Play>${silenceUrl}</Play>
</Response>
  `);
});

/* ============================
   SERVER + WEBSOCKET
============================ */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/stream")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    log("WS", "Upgrade OK - new client connected");
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
  try {
    log("ELEVENLABS", "TTS text:", text);

    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
      { text, model_id: "eleven_monolingual_v1" },
      { headers: { "xi-api-key": ELEVENLABS_KEY }, responseType: "arraybuffer" }
    );

    const tmp = path.join(os.tmpdir(), `tts-${Date.now()}.wav`);
    fs.writeFileSync(tmp, Buffer.from(r.data));
    const buffer = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buffer;
  } catch (err) {
    console.error("🔥 ELEVENLABS ERROR", err.response?.data || err.message);
    return null;
  }
}

/* ============================
   SEND AUDIO
============================ */
async function sendAudio(ws, buffer) {
  if (!ws.readyForAudio || ws.readyState !== WebSocket.OPEN || !buffer) {
    log("AUDIO", "Skipped: ws not ready or buffer missing");
    return;
  }

  const mulaw = await convertToMulaw(buffer);
  const FRAME = 160;
  const silence = Buffer.alloc(FRAME, 0xff);

  // Prime with silence
  for (let i = 0; i < 5; i++) {
    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws.streamSid,
      media: { payload: silence.toString("base64"), track: "outbound" }
    }));
    await sleep(20);
  }

  // Send actual frames
  for (let i = 0; i < mulaw.length; i += FRAME) {
    if (ws.readyState !== WebSocket.OPEN) break;
    let chunk = mulaw.slice(i, i + FRAME);
    if (chunk.length < FRAME) chunk = Buffer.concat([chunk, silence.slice(0, FRAME - chunk.length)]);
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
   WS HANDLER
============================ */
wss.on("connection", ws => {
  log("WS", "Client connected");
  ws.readyForAudio = false;

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
        ws.streamSid = data.start.streamSid;
        log("TWILIO", "Stream started", ws.streamSid);

        // Prime with silence immediately
        const silence = Buffer.alloc(160, 0xff);
        for (let i = 0; i < 10; i++) {
          ws.send(JSON.stringify({
            event: "media",
            streamSid: ws.streamSid,
            media: { payload: silence.toString("base64"), track: "outbound" }
          }));
        }

        // Allow Twilio to receive audio
        setTimeout(() => {
          ws.readyForAudio = true;
          log("AUDIO", "Twilio ready for outbound audio");
        }, 500);
      }

      if (data.event === "media" && dg.readyState === WebSocket.OPEN) {
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

      const reply = await callGemini(transcript);
      if (!reply) return;

      const audio = await tts(reply);
      if (audio) await sendAudio(ws, audio);
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
