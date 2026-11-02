# B8i Muse AI — Production Deployment Checklist
**Prepared:** 3 November 2026

Mark an item complete only after verifying it in the target deployment environment.

## Build and source control
- [ ] Confirm branch/commit SHA and clean working tree.
- [ ] Run `npm.cmd --prefix voice-gateway test` (expected last recorded result: 74/74).
- [ ] Rerun Worker tests (last reported result: 350/350).
- [ ] Review dependencies/runtime and lockfiles.
- [ ] Remove unneeded local smoke-test artifacts.
- [ ] Ensure no secrets, call recordings, transcripts or customer data are staged.

## Secrets and configuration
- [ ] Set secrets in the hosting/provider secret store.
- [ ] Verify Meta API access and ASR endpoint/event schema.
- [ ] Verify PCM encoding, sample rate, channels and audio conversions.
- [ ] Verify ElevenLabs key, voice ID and output format.
- [ ] Verify Exotel account, number, routing and webhook configuration.
- [ ] Ensure health endpoints reveal no secrets.

## Security and reliability
- [ ] Authenticate private endpoints; validate provider webhooks.
- [ ] Use TLS/WSS and intentional CORS rules.
- [ ] Apply request limits, rate limiting, validation and timeouts.
- [ ] Redact credentials, transcripts and personal data from logs.
- [ ] Verify graceful shutdown, WebSocket cleanup and caller disconnect handling.
- [ ] Add health checks, error/latency metrics, alerts and usage-spend alerts.

## End-to-end acceptance
- [ ] Controlled test call through intended route.
- [ ] Greeting, transcription, context continuity and audible response verified.
- [ ] Silence, noise, interruptions, long call and caller hang-up tested.
- [ ] ASR/model/TTS/provider failures recover safely.
- [ ] Instagram and marketplace/Razorpay regression tests pass.

## Rollout and rollback
- [ ] Deploy to staging or limited canary.
- [ ] Record version, commit SHA, timestamp and operator.
- [ ] Monitor failed calls, latency, ASR/TTS errors and spend.
- [ ] Document and verify rollback to previous version.
- [ ] Run post-deployment smoke tests and inspect redacted logs.

## Go / no-go
**GO** only when mandatory security, configuration, end-to-end and rollback checks are verified. Otherwise **NO-GO**; keep production voice traffic disabled.
