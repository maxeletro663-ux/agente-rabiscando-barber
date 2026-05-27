import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions, RATE } from "msedge-tts";
import axios from "axios";

export async function transcribeAudio(base64: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY!;
  const buffer = Buffer.from(base64, "base64");
  const blob = new Blob([buffer], { type: "audio/ogg" });

  const form = new globalThis.FormData();
  form.append("file", blob, "audio.ogg");
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "pt");
  form.append("response_format", "text");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq transcription error: ${err}`);
  }

  return (await res.text()).trim();
}

export async function textToSpeech(text: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata("pt-BR-AntonioNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const prosody = new ProsodyOptions();
  prosody.rate = RATE.FAST;

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const { audioStream } = tts.toStream(text, prosody);
    audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    audioStream.on("end", () => resolve(Buffer.concat(chunks)));
    audioStream.on("error", reject);
    setTimeout(() => reject(new Error("Edge TTS timeout")), 15000);
  });

  if (buffer.length === 0) throw new Error("Edge TTS retornou buffer vazio");
  console.log(`[tts] Edge TTS pt-BR-AntonioNeural: ${buffer.length} bytes`);
  return buffer;
}

export async function uploadAudio(audioBuffer: Buffer): Promise<string> {
  const base = process.env.TTS_SUPABASE_URL!;
  const key = process.env.TTS_SUPABASE_KEY!;
  const bucket = "tts-audio";
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;

  const res = await axios.post(
    `${base}/storage/v1/object/${bucket}/${filename}`,
    audioBuffer,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        "Content-Type": "audio/mpeg",
        "x-upsert": "true",
      },
      timeout: 15_000,
    }
  );

  if (res.status >= 400) throw new Error(`Supabase upload error: ${res.status}`);
  return `${base}/storage/v1/object/public/${bucket}/${filename}`;
}

