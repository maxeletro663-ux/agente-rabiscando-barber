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

// A edge function responde 409/422 com um JSON rico (type, message,
// horarios_disponiveis alternativos...). Se deixarmos o axios lançar em 4xx,
// tudo isso se perde e o modelo só vê "Request failed with status code 409" —
// aí ele começa a improvisar e narra o problema pro cliente. Por isso aceitamos
// qualquer 4xx com corpo JSON e devolvemos o corpo (garantindo success:false).
// 5xx e falha de rede continuam lançando (é instabilidade de verdade).
export async function callFunction<T = unknown>(
  fnName: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await axios.post(`${BASE}/functions/v1/${fnName}`, body, {
    headers,
    timeout: 30_000,
    validateStatus: (status) => status < 500,
  });
  if (res.status >= 400) {
    const data = res.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return { success: false, ...(data as Record<string, unknown>) } as T;
    }
    const err = new Error(`Edge function ${fnName} respondeu ${res.status}`) as Error & { response?: unknown };
    err.response = { status: res.status, data };
    throw err;
  }
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
