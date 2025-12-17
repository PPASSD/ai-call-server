require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const axios = require("axios");
const Twilio = require("twilio");

const app = express();
const port = process.env.PORT || 10000;

const {
  PUBLIC_HOST,
  DG_API_KEY,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  ELEVENLABS_KEY,
  ELEVENLABS_VOICE,
  ELEVENLABS_AGENT_ID,
  DEFAULT_PHONE,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER
} = process.env;

const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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
============================ */
app.post("/go-highlevel-webhook", async (req, res) => {
  try {
    log("GHL", "Webhook body:", JSON.stringify(req.body));

    const phone = req.body.contact?.phone || DEFAULT_PHONE;
    if (!phone) {
      log("GHL", "No phone number found in webhook payload");
      return res.status(400).send("No phone number provided");
    }

    log("GHL", "Attempting to call phone:", phone);

    // Create Twilio call
    const twilioCall = await twilioClient.calls.create({
      to: phone,
      from: TWILIO_NUMBER,
      url: `https://${PUBLIC_HOST}/twilio-voice-webhook`
    });

    log("TWILIO", "Call initiated successfully:", twilioCall.sid);

    res.status(200).json({ ok: true, sid: twilioCall.sid });
  } catch (err) {
    console.error("🔥 GHL WEBHOOK ERROR", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ============================
   TWILIO VOICE WEBHOOK
   Handles streaming to AI
============================ */
app.post("/twilio-voice-webhook", (req, res) => {
  const callSid = req.body.CallSid || "UNKNOWN";
  log("TWILIO", "Incoming Twilio call webhook triggered", callSid);

  const wsUrl = `wss://${PUBLIC_HOST.replace(/^https?:\/\//, "")}/stream`;

  // Start Twilio <Stream> for AI
  res.type("text/xml").send(`
<Response>
  <Start>
    <Stream url="${wsUrl}" track="both"/>
  </Start>
  <Pause length="3600"/>
</Response>
  `);
});

/* Optional endpoint to log when Dial completes */
app.post("/twilio-dial-complete", (req, res) => {
  log("TWILIO", "Dial completed callback:", req.body);
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
   ELEVENLABS TTS (Validates Voice ID)
============================ */
async function tts(text) {
  try {
    if (!ELEVENLABS_VOICE) {
      throw new Error("No ElevenLabs voice ID defined in environment variables");
    }

    // Validate voice ID before TTS
    try {
      const voiceInfo = await axios.get(
        `https://api.elevenlabs.io/v1/voices/${ELEVENLABS_VOICE}`,
        { headers: { "xi-api-key": ELEVENLABS_KEY } }
      );
      log("ELEVENLABS", "Using voice:", voiceInfo.data.name, `(ID: ${ELEVENLABS_VOICE})`);
    } catch (err) {
      console.warn("🔥 ELEVENLABS WARNING: Voice ID may be invalid", ELEVENLABS_VOICE, err.response?.data || err.message);
    }

    // Generate speech
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`;
    const body = { text, model_id: "eleven_monolingual_v1" };

    const r = await axios.post(url, body, {
      headers: { "xi-api-key": ELEVENLABS_KEY },
      responseType: "arraybuffer"
    });

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

  // Prime with 5 frames silence
  for (let i = 0; i < 5; i++) {
    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws.streamSid,
      media: { payload: silence.toString("base64"), track: "outbound" }
    }));
    await sleep(20);
  }

  // Send actual audio frames
  for (let i = 0; i < mulaw.length; i += FRAME) {
    if (ws.readyState !== WebSocket.OPEN) break;
    let chunk = mulaw.slice(i, i + FRAME);
    if (chunk.length < FRAME) chunk = Buffer.concat([chunk, Buffer.alloc(FRAME - chunk.length, 0xff)]);
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
