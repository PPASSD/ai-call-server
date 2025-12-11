# AI Call Server (Node.js)

Endpoints:
- POST /start-call  -> body { phone: "+1555...", leadId: "..." } (called by GoHighLevel)
- POST /twilio/voice -> Twilio voice webhook (returns TwiML that starts media stream)
- WebSocket /stream -> Twilio MediaStream connects here

Environment variables (set these in Render):
- TWILIO_ACCOUNT_SID
- TWILIO_AUTH_TOKEN
- TWILIO_FROM_NUMBER
- BASE_URL (https://your-service.onrender.com)
