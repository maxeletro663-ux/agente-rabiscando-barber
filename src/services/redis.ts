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
