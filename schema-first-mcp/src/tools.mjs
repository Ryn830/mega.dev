import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { addNote, searchNotes, saveFile } from './store.mjs';
import { safeFetch } from './safefetch.mjs';
import { transcribeAudio } from './transcribe.mjs';

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024);
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // provider limit

const ok = (structured, text) => ({
  content: [{ type: 'text', text: text ?? JSON.stringify(structured) }],
  structuredContent: structured,
});
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

/* ---------- the server ---------- */
export function createToolServer({ publicUrl }) {
  const server = new McpServer(
    { name: 'schema-first-mcp', version: '1.0.0' },
    {
      instructions:
        'Four tools. memo_write saves a short text note and returns its id. memo_search finds saved notes by words in their text. ' +
        'upload stores a file (base64 data, plain text, or an https URL) and returns a link served by this server. ' +
        'transcribe takes an https URL of an audio or video file (up to 25 MB and 15 minutes) and returns timestamped text segments; start and end are in seconds. ' +
        'Every result is structured content that matches the tool output schema. Errors name the input that failed and say why. ' +
        'Sign-in is OAuth 2.1 with PKCE; the plan page linked from the protected resource metadata explains what data is kept.',
    },
  );
  const base = publicUrl.replace(/\/$/, '');

  server.registerTool(
    'memo_write',
    {
      title: 'Save a note',
      description: 'Saves a short text note. Returns the id of the new note.',
      inputSchema: z.object({ text: z.string().min(1).max(20000).describe('The note text.') }),
      outputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text }) => {
      const note = await addNote(text);
      return ok({ id: note.id }, `Saved note ${note.id}.`);
    },
  );

  server.registerTool(
    'memo_search',
    {
      title: 'Find notes',
      description: 'Finds saved notes whose text matches the query words, best match first. An empty query returns the newest notes.',
      inputSchema: z.object({
        query: z.string().max(500).describe('Words to look for.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum notes to return. Default 20.'),
      }),
      outputSchema: z.object({
        notes: z.array(z.object({ id: z.string(), text: z.string(), created_at: z.string() })),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const notes = await searchNotes(query, limit ?? 20);
      return ok({ notes }, `${notes.length} note(s) found.`);
    },
  );

  server.registerTool(
    'upload',
    {
      title: 'Upload a file',
      description:
        'Stores a file on this server and returns a link anyone can open. Give the file as base64 in "data" (a data: URI also works), as plain "text", or as an https "url" to copy from.',
      inputSchema: z.looseObject({
        filename: z.string().max(200).optional().describe('File name, for example report.txt.'),
        contentType: z.string().max(100).optional().describe('Media type, for example text/plain.'),
        data: z.string().optional().describe('File bytes as base64, or a data: URI.'),
        text: z.string().optional().describe('File content as plain text (UTF-8).'),
        url: z.string().optional().describe('An https URL to copy the file from.'),
        prefix: z.string().max(1000).optional().describe('Optional text line to put on top of the file, as its own first line. A newline is added after it.'),
      }),
      outputSchema: z.object({ url: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      // Accept common alternative argument names.
      const name = args.filename ?? args.name ?? args.fileName ?? args.file_name;
      let type = args.contentType ?? args.content_type ?? args.mimeType ?? args.mime_type ?? args.mediaType;
      let dataField = args.data ?? args.content_base64 ?? args.base64 ?? args.bytes;
      const textField = args.text ?? (typeof args.content === 'string' ? args.content : undefined);
      let buffer;
      try {
        if (typeof dataField === 'string') {
          const m = dataField.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
          if (m) {
            type = type ?? (m[1] || undefined);
            buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
          } else {
            buffer = Buffer.from(dataField, 'base64');
          }
        } else if (typeof textField === 'string') {
          buffer = Buffer.from(textField, 'utf8');
          type = type ?? 'text/plain; charset=utf-8';
        } else if (typeof args.url === 'string') {
          const fetched = await safeFetch(args.url, { maxBytes: MAX_UPLOAD_BYTES });
          buffer = fetched.buffer;
          type = type ?? (fetched.contentType || undefined);
        } else {
          return fail('Provide the file as "data" (base64), "text", or "url".');
        }
      } catch (e) {
        return fail(e.message);
      }
      if (typeof args.prefix === 'string' && args.prefix.length > 0) {
        buffer = Buffer.concat([Buffer.from(args.prefix.replace(/\r?\n+$/, '') + '\n', 'utf8'), buffer]);
      }
      if (buffer.length === 0) return fail('The file is empty.');
      if (buffer.length > MAX_UPLOAD_BYTES) return fail(`The file is larger than ${MAX_UPLOAD_BYTES} bytes.`);
      const safeName = String(name || 'upload.bin').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload.bin';
      const contentType = String(type || 'application/octet-stream').slice(0, 100);
      try {
        const id = await saveFile(buffer, { name: safeName, contentType });
        const url = `${base}/files/${id}/${encodeURIComponent(safeName)}`;
        return ok({ url }, `Stored ${buffer.length} bytes. Link: ${url}`);
      } catch (e) {
        return fail(e.message);
      }
    },
  );

  server.registerTool(
    'transcribe',
    {
      title: 'Transcribe audio',
      description:
        'Downloads audio from an https URL and returns timestamped text segments, using a Whisper model that runs on this server. "start" and "end" are in seconds.',
      inputSchema: z.object({ url: z.string().describe('https URL of an audio (or video) file, up to 25 MB and 15 minutes.') }),
      outputSchema: z.object({
        segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
        duration: z.number().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const { buffer, contentType } = await safeFetch(url, { maxBytes: MAX_AUDIO_BYTES });
        let result;
        try {
          result = await transcribeAudio(buffer);
        } catch (e) {
          if (/^Could not read audio/.test(e.message) && /html|json|xml|text\//.test(contentType)) {
            throw new Error(`it is a web page or document (${contentType}), not an audio file. Could not read audio from it.`);
          }
          throw e;
        }
        return ok(result, `${result.segments.length} segment(s) transcribed.`);
      } catch (e) {
        return fail(`Could not transcribe ${url}: ${e.message}`);
      }
    },
  );

  return server;
}
