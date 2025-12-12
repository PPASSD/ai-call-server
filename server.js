// server.js (Node 22+)

import express from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import fetch from "node-fetch";
import twilio from "twilio";
import { VertexAI } from "@google-cloud/vertexai";

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- ENV VARS ---
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

// --- TWILIO CLIENT ---
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- ACTIVE STREAMS ---
const activeCalls = new Map();

// --- START CALL FROM GHL ---
app.post("/start-call", async (req, res) => {
  try {
    const { name, phone, email, source } = req.body;

    console.log("[start-call] Payload:", req.body);

    const call = await client.calls.create({
      from: TWILIO_NUMBER,
      to: phone,
      twiml: `
        <Response>
          <Start>
            <Stream url="wss://${req.headers.host}/media-stream" />
          </Start>
          <Say>Connecting you now.</Say>
        </Response>
      `,
    });

    console.log("[start-call] Twilio call created:", call.sid);

    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error("[start-call] ERROR:", error);
    res.status(500).send("Could not start call.");
  }
});

// --- TWILIO VOICE WEBHOOK ---
app.post("/twilio-voice-webhook", (req, res) => {
  const phone = req.body.Caller || req.body.From || "unknown";
  console.log("[twilio-voice-webhook] phone:", phone);

  activeCalls.set(phone, {});

  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/media-stream" />
      </Start>
      <Say>AI assistant connected.</Say>
    </Response>
  `;

  res.type("text/xml").send(twiml);
});

// --- MEDIA STREAM (TWILIO → GEMINI + DEEPGRAM) ---
app.ws("/media-stream", async (ws, req) => {
  const phone = "incoming-" + Math.random().toString(36).slice(2);
  console.log("[WS] MediaStream connected: phone=", phone);

  // --- CONNECT TO DEEPGRAM ---
  const dg = new WebSocket(
    "wss://api.deepgram.com/v1/listen",
    {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
    }
  );

  // --- CONNECT TO GEMINI ---
  const geminiURL =
    `wss://generativelanguage.googleapis.com/v1beta/models/` +
    `gemini-2.5-flash-lite:streamGenerateContent?key=${GOOGLE_API_KEY}`;

  const gem = new WebSocket(geminiURL);

  gem.on("open", () => {
    console.log("[Gemini] Connected OK");
    gem.send(
      JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "You are a phone AI assistant." }] }
        ]
      })
    );
  });

  gem.on("error", (err) => {
    console.error("[Gemini] WS error", err);
  });

  gem.on("close", () => {
    console.log("[Gemini] closed");
  });

  dg.on("open", () => {
    console.log("[DeepGram] WS open for phone=", phone);
  });

  dg.on("close", () => {
    console.log("[DeepGram] WS closed for phone=", phone);
  });

  // --- PROCESS AUDIO FROM TWILIO ---
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === "media") {
        const audioPayload = Buffer.from(data.media.payload, "base64");

        dg.send(audioPayload);
      }
    } catch (err) {
      console.error("[WS error]", err);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Twilio stream closed:", phone);
    dg.close();
    gem.close();
  });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
