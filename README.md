# B8i Muse AI — The Conversational Influencer Matchmaker

B8i explores conversational AI for connecting brands, vendors, and influencers.

## Architecture

- Cloudflare Worker: existing B8i marketplace and Instagram integration.
- Voice gateway: Node.js scaffold exploring Exotel, Meta Model API, transcription, and text-to-speech.

## Test results

- Worker tests: 350 passed, 0 failed.
- Voice gateway tests: 73 passed, 0 failed.

These are recorded automated test results, not proof of production readiness.

## Voice integration status

The voice gateway is not production-ready. The Meta realtime transcription handshake and event schema still require validation. The complete Exotel-to-model-to-audible-response flow has not been verified end to end.

## Local testing

Requirements: Node.js 20+ and npm.

Run the voice gateway tests:

```powershell
npm.cmd --prefix voice-gateway ci
npm.cmd --prefix voice-gateway test
```

Use voice-gateway/.env.example as a configuration template. Never commit real credentials, API keys, tokens, or customer data.

## Deployment safety

Do not enable production voice traffic until authentication, transcription, audio formats, timeouts, and call handling have been validated. Keep local testing separate from production deployment.

## License

No open-source license has been selected yet.
