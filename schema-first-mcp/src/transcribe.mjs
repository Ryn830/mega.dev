import { spawn } from 'node:child_process';

// Local speech-to-text: a Whisper model from Hugging Face, run with transformers.js (ONNX, CPU).
export const MODEL_ID = process.env.WHISPER_MODEL || 'onnx-community/whisper-base';
const MAX_SECONDS = Number(process.env.MAX_AUDIO_SECONDS || 900);
const SAMPLE_RATE = 16000;

let pipePromise;
export function loadModel() {
  pipePromise ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    if (process.env.MODEL_CACHE_DIR) env.cacheDir = process.env.MODEL_CACHE_DIR;
    return pipeline('automatic-speech-recognition', MODEL_ID, { dtype: 'q8' });
  })().catch((e) => {
    pipePromise = undefined; // allow a retry on the next call
    throw e;
  });
  return pipePromise;
}

/** Decode any audio or video container to mono 16 kHz float samples with ffmpeg. */
function decode(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-nostdin', '-v', 'error', '-i', 'pipe:0',
      '-vn', '-t', String(MAX_SECONDS + 1),
      '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1',
    ]);
    const out = [];
    let err = '';
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.on('data', (c) => { if (err.length < 2000) err += c; });
    ff.on('error', (e) => reject(new Error(`Audio decoder unavailable: ${e.message}`)));
    ff.on('close', (code) => {
      const raw = Buffer.concat(out);
      if (code !== 0 || raw.length < 4) return reject(new Error('Could not read audio from that file.'));
      const samples = new Float32Array(raw.length >> 2);
      for (let i = 0; i < samples.length; i++) samples[i] = raw.readFloatLE(i * 4);
      resolve(samples);
    });
    ff.stdin.on('error', () => {}); // ffmpeg may close early on bad input
    ff.stdin.end(buffer);
  });
}

let queue = Promise.resolve(); // one transcription at a time: the model uses the CPU fully

export function transcribeAudio(buffer) {
  const run = queue.then(async () => {
    const samples = await decode(buffer);
    const duration = samples.length / SAMPLE_RATE;
    if (duration > MAX_SECONDS) throw new Error(`Audio is longer than ${Math.round(MAX_SECONDS / 60)} minutes.`);
    const asr = await loadModel();
    const result = await asr(samples, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
    const segments = (result.chunks || [])
      .map((c) => ({
        start: Number(c.timestamp?.[0] ?? 0),
        end: Number(c.timestamp?.[1] ?? duration),
        text: String(c.text).trim(),
      }))
      .filter((s) => s.text);
    if (segments.length === 0 && result.text?.trim()) segments.push({ start: 0, end: duration, text: result.text.trim() });
    return { segments, duration: Math.round(duration * 100) / 100 };
  });
  queue = run.catch(() => {});
  return run;
}
