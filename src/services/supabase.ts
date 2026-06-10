import axios from "axios";

const BASE = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;
// Service role key is required to call edge functions that reject the anon key
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || ANON;

const headers = {
  Authorization: `Bearer ${SERVICE_ROLE}`,
  apikey: SERVICE_ROLE,
  "Content-Type": "application/json",
};

export async function callFunction<T = unknown>(
  fnName: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await axios.post(`${BASE}/functions/v1/${fnName}`, body, {
    headers,
    timeout: 30_000,
  });
  return res.data as T;
}

export async function getCustomerContext(
  whatsapp: string,
  userId: string
): Promise<unknown> {
  const res = await axios.get(
    `${BASE}/functions/v1/ai-customer-context?whatsapp=${whatsapp}&user_id=${userId}`,
    { headers, timeout: 30_000 }
  );
  return res.data;
}

export async function getUserByInstance(instanceName: string): Promise<{
  user_id: string;
  ai_agent_enabled: boolean;
  nome_agente: string;
  formas_pagamento: { label: string }[];
  horarios_por_dia: Record<string, string>;
  dias_abertos: string;
  dias_fechados: string;
  instance_api_key?: string | null;
} | null> {
  try {
    const data = await callFunction<{ user_id?: string; ai_agent_enabled?: boolean } & Record<string, unknown>>(
      "ai-agent-appointments",
      { action: "obter-usuario-por-instancia", data: { instance_name: instanceName } }
    );
    if (!data?.user_id) return null;
    return data as ReturnType<typeof getUserByInstance> extends Promise<infer T> ? Exclude<T, null> : never;
  } catch {
    return null;
  }
}
