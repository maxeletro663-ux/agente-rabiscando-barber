import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const DEBOUNCE_TTL = 8;       // seconds to wait for more messages
const LOCK_TTL = 150;          // seconds to block concurrent processing
const GREETING_TTL_FN = () => {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return Math.floor((end.getTime() - now.getTime()) / 1000);
};

export async function acquireLock(jid: string): Promise<boolean> {
  const key = `lock:agent:${jid}`;
  const result = await redis.set(key, "1", { nx: true, ex: LOCK_TTL });
  return result === "OK";
}

export async function releaseLock(jid: string) {
  await redis.del(`lock:agent:${jid}`);
}

export async function pushDebounce(jid: string, text: string): Promise<void> {
  const key = `debounce:${jid}`;
  await redis.rpush(key, text);
  await redis.expire(key, DEBOUNCE_TTL + 5);
}

export async function getDebounceMessages(jid: string): Promise<string[]> {
  const key = `debounce:${jid}`;
  const msgs = await redis.lrange(key, 0, -1);
  await redis.del(key);
  return msgs as string[];
}

export async function setDebounceWaiting(jid: string): Promise<void> {
  await redis.set(`debounce:waiting:${jid}`, "1", { ex: DEBOUNCE_TTL + 2 });
}

export async function isDebounceWaiting(jid: string): Promise<boolean> {
  const val = await redis.get(`debounce:waiting:${jid}`);
  return val !== null && val !== undefined;
}

export async function clearDebounceWaiting(jid: string): Promise<void> {
  await redis.del(`debounce:waiting:${jid}`);
}

export async function isGreetingSentToday(jid: string): Promise<boolean> {
  const spDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const dateStr = spDate.toISOString().slice(0, 10);
  const key = `saudacao:${jid}:${dateStr}`;
  const val = await redis.get(key);
  return val !== null && val !== undefined;
}

export async function markGreetingSent(jid: string): Promise<void> {
  const spDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const dateStr = spDate.toISOString().slice(0, 10);
  const key = `saudacao:${jid}:${dateStr}`;
  await redis.set(key, "enviada", { ex: GREETING_TTL_FN() });
}

const HUMAN_PAUSE_TTL = 1800; // 30 minutos

export async function setPausedByHuman(jid: string): Promise<void> {
  await Promise.all([
    redis.set(`pause:human:${jid}`, "1", { ex: HUMAN_PAUSE_TTL }),
    redis.del(`debounce:${jid}`),
    redis.del(`debounce:waiting:${jid}`),
  ]);
}

export async function isPausedByHuman(jid: string): Promise<boolean> {
  const val = await redis.get(`pause:human:${jid}`);
  return val !== null && val !== undefined;
}

// Eco do bot — distingue IA de humano num fromMe sem depender do campo
// "source" do Evolution (que fica ambíguo quando alguém manda mensagem manual
// pela mesma API). Cada texto enviado pelo bot vira uma chave própria e um
// fromMe só conta como "foi o bot" se o texto for EXATAMENTE igual a um eco.
//
// Antes havia um único eco (só a última mensagem, comparado por "contém") e
// uma flag bot:processing de 60 s que tratava QUALQUER fromMe como bot. O
// barbeiro quase sempre entra na conversa logo depois da resposta do bot, ou
// manda algo curto ("ok", "bom dia") contido na resposta — nos dois casos a
// pausa não acontecia (reclamação do Renan, 07/10/2026).
const BOT_ECHO_TTL = 180;
const BOT_MEDIA_TTL = 20;

function hashTexto(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + s.length;
}

export async function setBotEcho(jid: string, normalizedText: string): Promise<void> {
  if (!normalizedText) return;
  await redis.set(`bot:echo:${jid}:${hashTexto(normalizedText)}`, "1", { ex: BOT_ECHO_TTL });
}

export async function isBotEcho(jid: string, normalizedText: string): Promise<boolean> {
  if (!normalizedText) return false;
  const val = await redis.get(`bot:echo:${jid}:${hashTexto(normalizedText)}`);
  return val !== null && val !== undefined;
}

// Áudio/imagem do bot chegam no fromMe sem texto comparável: vale uma janela
// curta logo depois do envio.
export async function markBotSentMedia(jid: string): Promise<void> {
  await redis.set(`bot:media:${jid}`, "1", { ex: BOT_MEDIA_TTL });
}

export async function botSentMediaRecently(jid: string): Promise<boolean> {
  const val = await redis.get(`bot:media:${jid}`);
  return val !== null && val !== undefined;
}
