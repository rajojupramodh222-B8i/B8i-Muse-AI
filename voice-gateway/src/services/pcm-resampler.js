import { spawn } from 'node:child_process';

export function createPcmResampler({ onAudio, onError }) {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 's16le',
    '-ar', '8000',
    '-ac', '1',
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '16000',
    '-ac', '1',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderr = '';
  let ended = false;
  let reportedError = false;

  const reportError = error => {
    if (reportedError) return;
    reportedError = true;
    onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  ffmpeg.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });

  ffmpeg.stdout.on('data', chunk => {
    try {
      onAudio(chunk);
    } catch (error) {
      reportError(error);
    }
  });

  ffmpeg.on('error', reportError);

  const closed = new Promise(resolve => {
    ffmpeg.on('close', (code, signal) => {
      resolve({ code, signal });
      if (code !== 0 && !reportedError) {
        reportError(new Error(
          `FFmpeg exited with code ${code}: ${stderr || signal || 'unknown error'}`
        ));
      }
    });
  });

  return {
    write(chunk) {
      if (ended || ffmpeg.stdin.destroyed || !ffmpeg.stdin.writable) {
        return false;
      }
      return ffmpeg.stdin.write(chunk);
    },

    async end() {
      if (!ended) {
        ended = true;
        ffmpeg.stdin.end();
      }

      const result = await closed;
      if (result.code !== 0) {
        throw new Error(
          `FFmpeg conversion failed: ${stderr || result.signal || result.code}`
        );
      }
    },

    close() {
      ended = true;
      if (!ffmpeg.killed) ffmpeg.kill();
    }
  };
}
