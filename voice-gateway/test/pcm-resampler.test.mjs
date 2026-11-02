import test from 'node:test';
import assert from 'node:assert/strict';
import { createPcmResampler } from '../src/services/pcm-resampler.js';

test('resamples mono PCM16 from 8 kHz to 16 kHz', async () => {
  const chunks = [];
  const errors = [];

  const resampler = createPcmResampler({
    onAudio: chunk => chunks.push(Buffer.from(chunk)),
    onError: error => errors.push(error)
  });

  try {
    // 0.5 seconds of silence: 4,000 samples at 8 kHz.
    const input = Buffer.alloc(4000 * 2);

    for (let offset = 0; offset < input.length; offset += 640) {
      const accepted = resampler.write(
        input.subarray(offset, Math.min(offset + 640, input.length))
      );
      assert.notEqual(accepted, false, 'FFmpeg input should accept audio');
    }

    await resampler.end();

    const output = Buffer.concat(chunks);

    assert.equal(errors.length, 0, errors.map(e => e.message).join('; '));
    assert.ok(output.length > 0, 'FFmpeg should produce audio');
    assert.equal(output.length % 2, 0, 'PCM16 output must have complete samples');

    // 0.5 seconds at 16 kHz, 16-bit mono = approximately 16,000 bytes.
    assert.ok(
      Math.abs(output.length - 16000) < 2048,
      `Expected approximately 16000 output bytes; got ${output.length}`
    );
  } finally {
    resampler.close();
  }
});

