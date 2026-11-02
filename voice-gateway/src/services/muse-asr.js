
import WebSocket from 'ws';
import crypto from 'node:crypto';

export async function streamTranscription({ onTranscript, onError }) {
  const key = process.env.META_MODEL_API_KEY;

  if (!key) {
    throw new Error('META_MODEL_API_KEY is not configured');
  }

  const sessionId = crypto.randomUUID();
  const baseUrl =
    process.env.META_ASR_WS_URL ||
    'wss://api.meta.ai/v1/asr/realtime';

  const url = new URL(baseUrl);
  url.searchParams.set('sessionId', sessionId);

  const ws = new WebSocket(url.toString());

  let acknowledged = false;
  let closed = false;
  let handshakeSettled = false;
  let resolveHandshake;
  let rejectHandshake;

  const handshake = new Promise((resolve, reject) => {
    resolveHandshake = resolve;
    rejectHandshake = reject;
  });

  const reportError = err => {
    try {
      onError?.(
        err instanceof Error ? err : new Error(String(err))
      );
    } catch {}
  };

  // Register message handling BEFORE the handshake begins.
  ws.on('message', raw => {
    let event;

    try {
      event = JSON.parse(raw.toString());
    } catch {
      reportError(new Error('Meta ASR returned invalid JSON'));
      return;
    }

    // First server JSON message must acknowledge the session.
    if (!acknowledged) {
      if (event.sessionId) {
        acknowledged = true;
        handshakeSettled = true;
        console.log('Meta ASR connected:', event.sessionId);
        resolveHandshake();
        return;
      }

      handshakeSettled = true;
      rejectHandshake(
        new Error(
          `Meta ASR handshake rejected: ${
            JSON.stringify(event).slice(0, 300)
          }`
        )
      );
      return;
    }

    if (event.type === 'error') {
      reportError(
        new Error(`Meta ASR: ${event.message || 'transcription error'}`)
      );
      return;
    }

    if (
      event.type === 'speechComplete' &&
      typeof event.transcript === 'string' &&
      event.transcript.trim()
    ) {
      try {
        onTranscript?.(event.transcript.trim());
      } catch (err) {
        reportError(err);
      }
    }
  });

  ws.on('error', err => {
    if (!handshakeSettled) {
      handshakeSettled = true;
      rejectHandshake(err);
    } else {
      reportError(err);
    }
  });

  ws.on('close', (code, reason) => {
    closed = true;

    if (!handshakeSettled) {
      handshakeSettled = true;
      rejectHandshake(
        new Error(`Meta ASR closed during handshake: ${code}`)
      );
    } else if (code !== 1000) {
      reportError(
        new Error(`Meta ASR closed: ${code} ${reason.toString()}`)
      );
    }
  });

  const timer = setTimeout(() => {
    if (!handshakeSettled) {
      handshakeSettled = true;
      ws.terminate();
      rejectHandshake(new Error('Meta ASR connection timed out'));
    }
  }, 15000);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      authorization: {
        accessToken: `Bearer ${key}`
      },
      audioEncoding: 'PCM_16KHZ',
      model: 'muse-voice-transcribe-1.0',
      mode: 'ENDPOINTING',
      emitAudioProgress: true,
      languageBias: ['English'],
      keywords: ['B8i', 'influencer', 'campaign']
    }), err => {
      if (err && !handshakeSettled) {
        handshakeSettled = true;
        rejectHandshake(err);
      }
    });
  });

  try {
    await handshake;
  } catch (err) {
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return {
    sendAudio(chunk) {
      if (
        acknowledged &&
        !closed &&
        ws.readyState === WebSocket.OPEN
      ) {
        ws.send(chunk, err => {
          if (err) reportError(err);
        });
      }
    },

    end() {
      if (!closed && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'endStream' }), err => {
          if (err) reportError(err);
        });
      }
    },

    close() {
      if (!closed) {
        ws.close();
      }
    }
  };
}
