import axios from "axios";

const BASE = process.env.EVOLUTION_API_URL!;
const KEY = process.env.EVOLUTION_API_KEY!;

const api = axios.create({
  baseURL: BASE,
  headers: { apikey: KEY, "Content-Type": "application/json" },
  timeout: 30_000,
});

export async function sendText(instance: string, jid: string, text: string) {
  await api.post(`/message/sendText/${instance}`, {
    number: jid,
    text,
  });
}

export async function sendPresence(instance: string, jid: string, durationMs: number) {
  try {
    await api.post(`/chat/sendPresence/${instance}`, {
      number: jid,
      options: { presence: "composing", delay: durationMs },
    });
  } catch {
    // not critical
  }
}

export async function sendAudio(instance: string, jid: string, audioUrl: string) {
  await api.post(`/message/sendMedia/${instance}`, {
    number: jid,
    mediatype: "audio",
    media: audioUrl,
  });
}

export async function sendImage(
  instance: string,
  jid: string,
  imageUrl: string,
  caption: string
) {
  await api.post(`/message/sendMedia/${instance}`, {
    number: jid,
    mediatype: "image",
    mimetype: "image/jpeg",
    media: imageUrl,
    caption,
  });
}

export async function getMediaBase64(instance: string, messageId: string, jid: string) {
  const res = await api.post(`/chat/getBase64FromMediaMessage/${instance}`, {
    message: {
      key: {
        id: messageId,
        remoteJid: jid,
        fromMe: false,
      },
    },
  });
  // Evolution API pode retornar { base64: "..." } ou { data: { base64: "..." } }
  const data = res.data as Record<string, unknown>;
  const base64 = (data?.base64 || data?.data?.base64 || null) as string | null;
  return { base64 };
}
