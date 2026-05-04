import {
  acquireLock,
  releaseLock,
  pushDebounce,
  getDebounceMessages,
  setDebounceWaiting,
  isDebounceWaiting,
  clearDebounceWaiting,
  isGreetingSentToday,
  markGreetingSent,
} from "./services/redis";
import { sendText, sendPresence, sendAudio, sendImage, getMediaBase64 } from "./services/evolution";
import { transcribeAudio, textToSpeech, uploadAudio } from "./services/elevenlabs";
import { getUserByInstance, getCustomerContext } from "./services/supabase";
import { runAgent } from "./agent";
import type Anthropic from "@anthropic-ai/sdk";

// In-memory conversation history per JID (cleared after 24h of inactivity)
const historyStore = new Map<string, { msgs: Anthropic.MessageParam[]; lastAt: number }>();

const DEBOUNCE_WAIT_MS = 6_000;
const HISTORY_MAX = 20; // max message pairs to keep

// Instance that uses TTS audio responses
const TTS_INSTANCES = new Set(["bela"]);

// Greeting config per instance
const GREETING_CONFIG: Record<string, { imageUrl: string; caption: string }> = {
  rabiscandobarber: {
    imageUrl:
      "https://xfvhrnydfeyjnsskpnkj.supabase.co/storage/v1/object/public/booking-assets/a59dbcb6-bbce-466d-ab68-fd70e6eb5da8/logo/1770747474138.jpg",
    caption:
      "Opá, beleza? Sou Roboaldo assistente virtual da Rabiscando Barber 🤖\nDe preferência faça o agendamento pela nossa página:\nhttps://app.appbarberzap.com.br/b/rabiscandobarber\nMas se quiser pode falar comigo!",
  },
};

function normalizeJid(jid: string): string {
  return jid.replace("@s.whatsapp.net", "").replace(/\D/g, "").replace(/^55/, "");
}

function getHistory(jid: string): Anthropic.MessageParam[] {
  const entry = historyStore.get(jid);
  if (!entry) return [];
  // Clear if inactive > 24h
  if (Date.now() - entry.lastAt > 24 * 60 * 60 * 1000) {
    historyStore.delete(jid);
    return [];
  }
  return entry.msgs;
}

function saveHistory(jid: string, userText: string, assistantText: string) {
  const existing = getHistory(jid);
  const updated = [
    ...existing,
    { role: "user" as const, content: userText },
    { role: "assistant" as const, content: assistantText },
  ];
  // Keep last HISTORY_MAX pairs
  const trimmed = updated.slice(-HISTORY_MAX * 2);
  historyStore.set(jid, { msgs: trimmed, lastAt: Date.now() });
}

function splitResponse(text: string, limit = 250): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;

  // Single long paragraph — split by sentences
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const blocks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if ((current + " " + s).length <= limit) {
      current = (current + " " + s).trim();
    } else {
      if (current) blocks.push(current);
      current = s;
    }
  }
  if (current) blocks.push(current);
  return blocks.length > 0 ? blocks : [text];
}

async function sendResponseBlocks(
  instance: string,
  jid: string,
  blocks: string[],
  useTts: boolean
) {
  for (const block of blocks) {
    const cps = 40;
    const delay = Math.max(1000, Math.round((block.length / cps) * 1000));
    await sendPresence(instance, jid, delay);
    await new Promise((r) => setTimeout(r, delay));

    if (useTts) {
      try {
        const audioBuffer = await textToSpeech(block);
        const audioUrl = await uploadAudio(audioBuffer);
        await sendAudio(instance, jid, audioUrl);
      } catch {
        await sendText(instance, jid, block);
      }
    } else {
      await sendText(instance, jid, block);
    }
  }
}

export async function processMessage(payload: {
  instance: string;
  jid: string;
  fromMe: boolean;
  messageType: string;
  text?: string;
  audioBase64?: string;
  messageId?: string;
  pushName?: string;
}) {
  const { instance, jid, fromMe, messageType } = payload;

  // Ignore groups, self-messages, stickers, reactions, videos
  if (fromMe) return;
  if (jid.includes("@g.us")) return;
  if (["stickerMessage", "reactionMessage", "videoMessage"].includes(messageType)) return;

  // Acquire processing lock to avoid concurrent execution for same JID
  const locked = await acquireLock(jid);
  if (!locked) {
    // Already processing — queue the message for debounce
    if (payload.text) await pushDebounce(jid, payload.text);
    return;
  }

  try {
    let text = payload.text || "";

    // Transcribe audio if needed
    if (messageType === "audioMessage" && payload.messageId) {
      try {
        const media = await getMediaBase64(instance, payload.messageId);
        const base64 = media?.data?.base64;
        if (base64) {
          text = await transcribeAudio(base64);
        }
      } catch {
        text = "[Áudio não transcrito]";
      }
    }

    if (!text && messageType !== "audioMessage") return;

    // Debounce: push message and wait for more
    await pushDebounce(jid, text);

    if (await isDebounceWaiting(jid)) {
      // Another debounce timer is already running — just queued the message
      return;
    }

    await setDebounceWaiting(jid);
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT_MS));
    await clearDebounceWaiting(jid);

    // Collect all debounced messages
    const messages = await getDebounceMessages(jid);
    if (messages.length === 0) return;

    // Lookup user by instance
    const userInfo = await getUserByInstance(instance);
    if (!userInfo) {
      console.warn(`[${instance}] Instância não encontrada no sistema`);
      return;
    }

    if (!userInfo.ai_agent_enabled) return;

    const whatsappClean = normalizeJid(jid);

    // First message of day greeting
    const greetingSent = await isGreetingSentToday(jid);
    if (!greetingSent) {
      const greeting = GREETING_CONFIG[instance];
      if (greeting) {
        await sendImage(instance, jid, greeting.imageUrl, greeting.caption);
      }
      await markGreetingSent(jid);
    }

    // Get customer context
    let context: Record<string, unknown> = {};
    try {
      context = (await getCustomerContext(whatsappClean, userInfo.user_id)) as Record<string, unknown>;
    } catch (e) {
      console.error("Erro ao obter contexto do cliente:", e);
    }

    // Run Claude agent
    const history = getHistory(jid);
    const combinedText = messages.join("\n");

    const agentResponse = await runAgent({
      messages,
      history,
      userId: userInfo.user_id,
      clienteWhatsapp: whatsappClean,
      clienteNome: payload.pushName || whatsappClean,
      context,
      userInfo: userInfo as unknown as Record<string, unknown>,
    });

    if (!agentResponse) return;

    // Save to history
    saveHistory(jid, combinedText, agentResponse);

    // Send response
    const useTts = TTS_INSTANCES.has(instance);
    const blocks = splitResponse(agentResponse);
    await sendResponseBlocks(instance, jid, blocks, useTts);
  } finally {
    releaseLock(jid);
  }
}
