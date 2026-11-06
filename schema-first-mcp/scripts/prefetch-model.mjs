// Run at image build time so the first transcribe call does not wait for a download.
import { loadModel, MODEL_ID } from '../src/transcribe.mjs';

await loadModel();
console.log(`model ready: ${MODEL_ID}`);
