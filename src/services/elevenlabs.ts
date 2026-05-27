import axios from "axios";
import FormData from "form-data";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const UPLOAD_URL = process.env.AUDIO_UPLOAD_URL!;

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
  await tts.setMetadata("pt-BR-AntonioNeural", OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const { audioStream } = tts.toStream(text);
    audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    audioStream.on("end", () => resolve(Buffer.concat(chunks)));
    audioStream.on("error", reject);
    setTimeout(() => reject(new Error("Edge TTS timeout")), 15000);
  });

  if (buffer.length === 0) throw new Error("Edge TTS retornou buffer vazio");
  console.log(`[tts] Edge TTS (pt-BR-AntonioNeural): ${buffer.length} bytes`);
  return buffer;
}

export async function uploadAudio(audioBuffer: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", audioBuffer, { filename: "response.mp3", contentType: "audio/mpeg" });

  const res = await axios.post(UPLOAD_URL, form, {
    headers: form.getHeaders(),
    timeout: 30_000,
  });
  return (res.data as { url: string }).url;
}
