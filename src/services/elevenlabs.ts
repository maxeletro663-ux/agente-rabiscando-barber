import axios from "axios";
import FormData from "form-data";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const API_KEY = process.env.ELEVENLABS_API_KEY!;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID!;
const UPLOAD_URL = process.env.AUDIO_UPLOAD_URL!;

export async function transcribeAudio(base64: string): Promise<string> {
  const buffer = Buffer.from(base64, "base64");
  const form = new FormData();
  form.append("file", buffer, { filename: "audio.ogg", contentType: "audio/ogg" });
  form.append("model_id", "scribe_v1");
  form.append("language_code", "pt");

  const res = await axios.post(
    "https://api.elevenlabs.io/v1/speech-to-text",
    form,
    {
      headers: { ...form.getHeaders(), "xi-api-key": API_KEY },
      timeout: 30_000,
    }
  );
  return (res.data as { text: string }).text || "";
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
