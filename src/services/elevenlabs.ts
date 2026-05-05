import axios from "axios";
import FormData from "form-data";

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
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.9,
        similarity_boost: 1,
        style: 0,
        use_speaker_boost: true,
        speed: 1.15,
      },
    },
    {
      headers: { "xi-api-key": API_KEY, "Content-Type": "application/json" },
      responseType: "arraybuffer",
      timeout: 60_000,
    }
  );
  return Buffer.from(res.data as ArrayBuffer);
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
