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
  setPausedByHuman,
  isPausedByHuman,
} from "./services/redis";
import { sendText, sendPresence, sendAudio, sendImage, getMediaBase64, registerInstanceKey } from "./services/evolution";
import { transcribeAudio, textToSpeech, uploadAudio } from "./services/elevenlabs";
import { getUserByInstance, getCustomerContext } from "./services/supabase";
import { runAgent } from "./agent";
import type Anthropic from "@anthropic-ai/sdk";

// In-memory conversation history per JID (cleared after 24h of inactivity)
const historyStore = new Map<string, { msgs: Anthropic.MessageParam[]; lastAt: number }>();

const DEBOUNCE_WAIT_MS = 6_000;
const HISTORY_MAX = 20; // max message pairs to keep

// Alias de instâncias: instâncias de teste apontam para o user_id de outra instância no Supabase
const INSTANCE_ALIAS: Record<string, string> = {
  Ativa: "rabiscandobarber",
};

// Keys fixas por instância (fallback quando Supabase não retorna instance_api_key)
const INSTANCE_KEYS_FALLBACK: Record<string, string> = {
  Ativa: "D5013BE220CB-4E2C-B42E-FECC8309AD81",
};

// Instance that uses TTS audio responses
const TTS_INSTANCES = new Set(["bela"]);

// Greeting config per instance — imageUrl optional
const GREETING_CONFIG: Record<string, { imageUrl?: string; caption: string }> = {
  rabiscandobarber: {
    imageUrl:
      "https://rhdkerccjbhjeylemlsw.supabase.co/storage/v1/object/public/booking-assets/logo/rabiscando.jpg",
    caption:
      "Opá, beleza? Sou Roboaldo, assistente virtual da Rabiscando Barber 🤖\nDe preferência faça o agendamento pela nossa página:\nhttps://app.appbarberzap.com.br/b/rabiscandobarber\nMas se quiser pode falar comigo!",
  },
  teste02: {
    imageUrl:
      "https://xfvhrnydfeyjnsskpnkj.supabase.co/storage/v1/object/public/booking-assets/a59dbcb6-bbce-466d-ab68-fd70e6eb5da8/logo/1770747474138.jpg",
    caption:
      "Opá, beleza? Sou Roboaldo, assistente virtual da Rabiscando Barber 🤖\nDe preferência faça o agendamento pela nossa página:\nhttps://app.appbarberzap.com.br/b/rabiscandobarber\nMas se quiser pode falar comigo!",
  },
  Ativa: {
    imageUrl:
      "https://rhdkerccjbhjeylemlsw.supabase.co/storage/v1/object/public/booking-assets/logo/rabiscando.jpg",
    caption:
      "Opá, beleza? Sou Roboaldo, assistente virtual da Rabiscando Barber 🤖\nDe preferência faça o agendamento pela nossa página:\nhttps://app.appbarberzap.com.br/b/rabiscandobarber\nMas se quiser pode falar comigo!",
  },
};

// Logo por instância — usado ao enviar o link de agendamento
const LOGO_URL: Record<string, string> = {
  rabiscandobarber:
    "https://rhdkerccjbhjeylemlsw.supabase.co/storage/v1/object/public/booking-assets/logo/rabiscando.jpg",
  teste02:
    "https://xfvhrnydfeyjnsskpnkj.supabase.co/storage/v1/object/public/booking-assets/a59dbcb6-bbce-466d-ab68-fd70e6eb5da8/logo/1770747474138.jpg",
  Ativa:
    "https://rhdkerccjbhjeylemlsw.supabase.co/storage/v1/object/public/booking-assets/logo/rabiscando.jpg",
};

const BOOKING_URL_PATTERN = /https:\/\/app\.appbarberzap\.com\.br\/b\/\S+/;

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

function saveHistory(jid: string, newMessages: Anthropic.MessageParam[]) {
  const existing = getHistory(jid);
  const updated = [...existing, ...newMessages];
  // Keep last HISTORY_MAX * 2 mensagens (cada turno pode ter várias mensagens com tool calls)
  const trimmed = updated.slice(-HISTORY_MAX * 4);
  historyStore.set(jid, { msgs: trimmed, lastAt: Date.now() });
}

function cleanMarkdown(text: string): string {
  // Remove ** ao redor de URLs para não quebrar links no WhatsApp
  return text.replace(/\*\*(https?:\/\/[^\s*]+)\*\*/g, "$1")
             .replace(/\*(https?:\/\/[^\s*]+)\*/g, "$1");
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

    // Se o bloco contém o link de agendamento, envia como imagem + caption
    const logoUrl = LOGO_URL[instance];
    if (logoUrl && BOOKING_URL_PATTERN.test(block)) {
      try {
        await sendImage(instance, jid, logoUrl, block);
        continue;
      } catch {
        // fallback para texto se a imagem falhar
      }
    }

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
  source?: string;
  messageType: string;
  text?: string;
  audioBase64?: string;
  messageId?: string;
  pushName?: string;
}) {
  const { instance, jid, fromMe, source, messageType } = payload;

  // Log diagnóstico para entender o payload de todas as mensagens
  console.log(`[${instance}] msg: jid=${jid} fromMe=${fromMe} source="${source}" type=${messageType}`);

  // Ignore groups
  if (jid.includes("@g.us")) return;

  // Mensagens enviadas da instância (fromMe)
  if (fromMe) {
    // Se não veio via API (operador humano no celular/web) → pausar o bot por 5 min
    // Nota: source pode ser "" quando enviado pelo celular/web — por isso não fazemos
    // guard de truthiness; só excluímos source === "api" (mensagens do próprio bot)
    if (source !== "api" && !jid.includes("@g.us")) {
      await setPausedByHuman(jid);
      console.log(`[${instance}] Intervenção humana detectada (source="${source}") para ${jid} — pausando 5 min`);
    }
    return;
  }

  if (["stickerMessage", "reactionMessage", "videoMessage"].includes(messageType)) return;

  // Verificar se o bot está pausado por intervenção humana
  if (await isPausedByHuman(jid)) {
    console.log(`[${instance}] Bot pausado por intervenção humana para ${jid}`);
    return;
  }

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
      if (text) {
        // WhatsApp já enviou transcrição nativa (speechToText) — usa ela diretamente
        console.log(`[${instance}] Usando speechToText nativo do WhatsApp`);
      } else {
        // Sem transcrição nativa — tenta via ElevenLabs
        try {
          const media = await getMediaBase64(instance, payload.messageId, jid);
          const base64 = media?.base64;
          if (base64) {
            text = await transcribeAudio(base64);
            console.log(`[${instance}] Áudio transcrito via ElevenLabs`);
          } else {
            console.warn(`[${instance}] Áudio sem base64: messageId=${payload.messageId}`);
          }
        } catch (err) {
          console.error(`[${instance}] Erro ao transcrever áudio:`, err);
        }

        // Se ainda sem texto, pede para o cliente enviar por escrito
        if (!text) {
          await sendText(instance, jid, "Não consegui entender o áudio 😅 Pode mandar por texto?");
          return;
        }
      }
    }

    if (!text) return;

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

    // Re-check pause: human may have intervened during the debounce wait
    if (await isPausedByHuman(jid)) {
      console.log(`[${instance}] Bot pausado por intervenção humana (pós-debounce) para ${jid}`);
      return;
    }

    // Lookup user by instance (resolve alias antes de buscar)
    const lookupInstance = INSTANCE_ALIAS[instance] ?? instance;
    const userInfo = await getUserByInstance(lookupInstance);
    if (!userInfo) {
      console.warn(`[${instance}] Instância não encontrada no sistema (lookup: ${lookupInstance})`);
      return;
    }

    const instanceKey = userInfo.instance_api_key || INSTANCE_KEYS_FALLBACK[instance];
    if (instanceKey) registerInstanceKey(instance, instanceKey);
    console.log(`[${instance}] instance_api_key: ${instanceKey ? instanceKey.slice(0, 8) + "..." : "null — usando default"}`);

    if (!userInfo.ai_agent_enabled) return;

    const whatsappClean = normalizeJid(jid);

    // First message of day greeting
    const greetingSent = await isGreetingSentToday(jid);
    if (!greetingSent) {
      const greeting = GREETING_CONFIG[instance];
      if (greeting) {
        try {
          if (greeting.imageUrl) {
            await sendImage(instance, jid, greeting.imageUrl, greeting.caption);
          } else {
            await sendText(instance, jid, greeting.caption);
          }
        } catch (err) {
          console.error(`[${instance}] Erro ao enviar saudação:`, err);
        }
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

    const { text: agentResponse, newMessages } = await runAgent({
      messages,
      history,
      userId: userInfo.user_id,
      clienteWhatsapp: whatsappClean,
      clienteNome: payload.pushName || whatsappClean,
      context,
      userInfo: userInfo as unknown as Record<string, unknown>,
    });

    if (!agentResponse) return;

    // Re-check pause after Claude generation — human may have intervened during the API call
    if (await isPausedByHuman(jid)) {
      console.log(`[${instance}] Bot pausado por intervenção humana (pós-geração) para ${jid} — resposta descartada`);
      return;
    }

    // Salva histórico completo (inclui tool calls/results para manter appointment_id entre turnos)
    saveHistory(jid, newMessages);

    // Send response
    const useTts = TTS_INSTANCES.has(instance);
    const blocks = splitResponse(cleanMarkdown(agentResponse));
    await sendResponseBlocks(instance, jid, blocks, useTts);
  } finally {
    releaseLock(jid);
  }
}
