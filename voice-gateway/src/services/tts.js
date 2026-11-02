import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Returns raw PCM16 mono 8kHz audio for Exotel.
 * Requires ffmpeg installed and available on PATH for format conversion.
 */
export async function synthesizeSpeech(text) {
  const provider = (process.env.TTS_PROVIDER || '').toLowerCase();
  let audio;
  let contentType = '';
  if (provider === 'elevenlabs') {
    const key = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!key || !voiceId) throw new Error('Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID');
    const model = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_16000`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/pcm' },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    audio = Buffer.from(await response.arrayBuffer());
    contentType = 'pcm16-16000';
  } else {
    throw new Error(`Unsupported TTS_PROVIDER "${provider}". Implement/configure an adapter before production.`);
  }
  if (contentType !== 'pcm16-16000') throw new Error('Unexpected TTS audio format');
  return await resamplePcm16To8k(audio);
}

async function resamplePcm16To8k(pcm16k) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'b8i-tts-'));
  const input = path.join(dir, 'in.pcm');
  const output = path.join(dir, 'out.pcm');
  try {
    await writeFile(input, pcm16k);
    await execFileAsync('ffmpeg', ['-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', input, '-f', 's16le', '-ar', '8000', '-ac', '1', output], { timeout: 20000 });
    return await readFile(output);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
