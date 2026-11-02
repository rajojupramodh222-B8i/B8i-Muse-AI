# B8i Muse Voice Gateway (starter)

This is an isolated Node.js gateway for connecting Exotel AgentStream to Meta Model API and a configurable TTS provider. It does not modify your existing Cloudflare Worker.

## What is included

- `GET /healthz` — reports configuration flags, never secrets.
- `POST /api/voice/ask` — authenticated text-only smoke test for Muse Spark.
- `WS /voice/ws?token=...` — Exotel AgentStream event handler for connected/start/media/stop and reverse audio.
- Muse Spark Messages API adapter (`POST https://api.meta.ai/v1/messages`).
- Muse Voice Transcribe WebSocket adapter guarded by a required explicit handshake JSON.
- ElevenLabs TTS example adapter that converts PCM 16 kHz to Exotel PCM 8 kHz using `ffmpeg`.

## Important status

This is a **starter scaffold, not yet production-ready**. Meta's realtime ASR handshake/event fields must be copied from the current Voice API reference for your Meta account into `META_ASR_HANDSHAKE_JSON`. Do not guess them. Validate transcription events and audio input sample-rate requirements before connecting live calls. Also test the chosen TTS voice and ffmpeg conversion on your machine.

The Exotel protocol follows the documented JSON events: `connected`, `start`, `media`, and `stop`. Exotel sends base64 PCM; reverse audio must be raw mono PCM16 little-endian and sent in appropriately sized chunks. See https://developer.exotel.com/docs/agentstream/websocket-protocol.

## Requirements

- Node.js 20+
- ffmpeg installed and available on PATH (for ElevenLabs PCM conversion)
- Meta Model API access and key
- TTS provider credentials
- Public WSS host (for example a temporary tunnel for development)
- Exotel Voicebot/AgentStream enabled for your account

## Run locally (PowerShell)

```powershell
cd b8i-muse-voice-gateway
Copy-Item .env.example .env
npm install
```

Edit `.env` and set:
- `VOICE_GATEWAY_SECRET` to a long random secret
- `META_MODEL_API_KEY`
- `TTS_PROVIDER=elevenlabs`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `META_ASR_HANDSHAKE_JSON` to the exact documented JSON handshake for your Meta account (escape JSON as a single line)

Start:

```powershell
npm run dev
```

Check:

```powershell
Invoke-RestMethod http://localhost:8080/healthz
```

Test Muse text endpoint:

```powershell
$headers = @{ Authorization = "Bearer YOUR_VOICE_GATEWAY_SECRET" }
$body = @{ message = "Say hello to a B8i vendor in one sentence." } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/voice/ask -Headers $headers -ContentType "application/json" -Body $body
```

## Expose a development WSS endpoint

Use a secure tunnel such as Cloudflare Tunnel or ngrok. The resulting WebSocket URL should be:

`wss://YOUR_PUBLIC_HOST/voice/ws?token=YOUR_LONG_RANDOM_SECRET`

**Do not use this query-token design unchanged in production.** Query strings may be logged. Prefer a signed short-lived per-call token or a verified Exotel IP/signature strategy and avoid logging full URLs.

## Connect Exotel

For outbound test calls, use Exotel's Connect Voice AI API with:
- `StreamType=bidirectional`
- `StreamUrl=wss://YOUR_PUBLIC_HOST/voice/ws?token=...`

For inbound calls, configure the ExoPhone's assigned App Bazaar flow with the Voicebot applet pointing at the public WSS URL. Inbound routing depends on your Exotel account features and configuration.

Reference: https://developer.exotel.com/docs/agentstream/connect-voice-ai

## Before production

1. Implement and test the exact Muse realtime ASR handshake and final-transcript event schema.
2. Add per-call transcript/audio buffering, endpointing, interruption/barge-in, and concurrency limits.
3. Replace static shared query token with short-lived signed tokens.
4. Add call-level auth and rate limiting.
5. Add B8i actions only through a separately authenticated backend API; do not expose payments, payouts, or account changes to unverified caller ID.
6. Keep B8i's existing Instagram and Razorpay routes unchanged.
7. Test health check, text generation, TTS audio format, ASR, inbound and outbound calls before rollout.
