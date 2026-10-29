import { config } from '../config';

/**
 * Speech-to-text with Groq's hosted Whisper (whisper-large-v3-turbo, Hindi).
 * The audio is sent straight from memory, so no temp files are left behind.
 */
export async function transcribeAudio(
  audio: Buffer,
  mimeType = 'audio/m4a',
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!config.GROQ_API_KEY) throw new Error('GROQ_API_KEY is missing');

  const form = new FormData();
  const ext = mimeType.includes('mpeg')
    ? 'mp3'
    : /mp4|m4a|aac/.test(mimeType) // the Android app records AAC in an .m4a file
      ? 'm4a'
      : 'ogg';
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${ext}`);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'hi'); // Hindi / Hinglish
  form.append('response_format', 'json');

  const response = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const err = new Error(`Groq API error [${response.status}]: ${(await response.text()).slice(0, 300)}`);
    (err as any).status = response.status;
    throw err;
  }
  const data: any = await response.json();
  return String(data.text || '').trim();
}
