/**
 * Camada unificada de LLM — suporta Anthropic (Claude) e DeepSeek.
 *
 * Provedor detectado automaticamente pelo prefixo do modelo:
 *   "deepseek-*"  → DeepSeek API (OpenAI-compatible, DEEPSEEK_API_KEY)
 *   qualquer outro → Anthropic (ANTHROPIC_API_KEY)
 */

import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";

// ─── Tipo de resposta compatível com Anthropic (usado pelos dois provedores) ──
export type LLMResponse = {
  stop_reason: "end_turn" | "tool_use";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
};

// ─── Detecção de provedor ────────────────────────────────────────────────────
export function isDeepSeekModel(model: string): boolean {
  return model.startsWith("deepseek-");
}

// ─── Cliente Anthropic com cache por API key ─────────────────────────────────
const anthropicCache = new Map<string, Anthropic>();

function getAnthropic(apiKey?: string): Anthropic {
  const key = apiKey || process.env.ANTHROPIC_API_KEY!;
  if (!anthropicCache.has(key)) anthropicCache.set(key, new Anthropic({ apiKey: key }));
  return anthropicCache.get(key)!;
}

// ─── Chamada Anthropic ───────────────────────────────────────────────────────
async function callClaude(params: {
  model: string;
  messages: Anthropic.MessageParam[];
  system: string;
  tools: Anthropic.Tool[];
  max_tokens: number;
  temperature: number;
  anthropicApiKey?: string;
}): Promise<LLMResponse> {
  const client = getAnthropic(params.anthropicApiKey);
  const res = await client.messages.create({
    model: params.model,
    max_tokens: params.max_tokens,
    temperature: params.temperature,
    system: params.system,
    tools: params.tools,
    messages: params.messages,
  });
  return {
    stop_reason: res.stop_reason as "end_turn" | "tool_use",
    content: res.content as LLMResponse["content"],
  };
}

// ─── Conversão de mensagens Anthropic → OpenAI ───────────────────────────────
type OAIMessage = Record<string, unknown>;

function toOpenAIMessages(msgs: Anthropic.MessageParam[], system: string): OAIMessage[] {
  const result: OAIMessage[] = [{ role: "system", content: system }];

  for (const msg of msgs) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = msg.content as any[];

    if (msg.role === "user") {
      const toolResults = blocks.filter((b) => b.type === "tool_result");
      const textBlocks = blocks.filter((b) => b.type === "text");

      for (const tr of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content:
            typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
        });
      }
      if (textBlocks.length > 0) {
        result.push({ role: "user", content: textBlocks.map((b: any) => b.text).join("\n") });
      }
    } else {
      const textBlocks = blocks.filter((b) => b.type === "text");
      const toolUses = blocks.filter((b) => b.type === "tool_use");

      if (toolUses.length > 0) {
        result.push({
          role: "assistant",
          content: textBlocks.length > 0 ? textBlocks.map((b: any) => b.text).join("\n") : null,
          tool_calls: toolUses.map((b: any) => ({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
        });
      } else {
        result.push({
          role: "assistant",
          content: textBlocks.map((b: any) => b.text).join("\n"),
        });
      }
    }
  }

  return result;
}

// ─── Conversão de tools Anthropic → OpenAI ───────────────────────────────────
function toOpenAITools(tools: Anthropic.Tool[]): OAIMessage[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// ─── Chamada DeepSeek (API OpenAI-compatible) ────────────────────────────────
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1/chat/completions";

async function callDeepSeek(params: {
  model: string;
  messages: Anthropic.MessageParam[];
  system: string;
  tools: Anthropic.Tool[];
  max_tokens: number;
  temperature: number;
  deepseekApiKey?: string;
}): Promise<LLMResponse> {
  const apiKey = params.deepseekApiKey || process.env.DEEPSEEK_API_KEY!;

  const { data } = await axios.post(
    DEEPSEEK_BASE_URL,
    {
      model: params.model,
      messages: toOpenAIMessages(params.messages, params.system),
      tools: toOpenAITools(params.tools),
      tool_choice: "auto",
      temperature: params.temperature,
      max_tokens: params.max_tokens,
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: 60_000,
    }
  );

  const choice = data.choices[0];
  const msg = choice.message;

  if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
    return {
      stop_reason: "tool_use",
      content: msg.tool_calls.map((tc: any) => ({
        type: "tool_use" as const,
        id: tc.id,
        name: tc.function.name,
        input: (() => {
          try { return JSON.parse(tc.function.arguments); } catch { return {}; }
        })(),
      })),
    };
  }

  return {
    stop_reason: "end_turn",
    content: [{ type: "text" as const, text: msg.content || "" }],
  };
}

// ─── Ponto de entrada unificado ──────────────────────────────────────────────
export async function callLLM(params: {
  model: string;
  messages: Anthropic.MessageParam[];
  system: string;
  tools: Anthropic.Tool[];
  max_tokens: number;
  temperature: number;
  anthropicApiKey?: string;
  deepseekApiKey?: string;
}): Promise<LLMResponse> {
  return isDeepSeekModel(params.model)
    ? callDeepSeek(params)
    : callClaude(params);
}
