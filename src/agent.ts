import Anthropic from "@anthropic-ai/sdk";
import { callFunction, getCustomerContext } from "./services/supabase";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const TOOLS: Anthropic.Tool[] = [
  {
    name: "listar-servicos",
    description: "Lista todos os serviços disponíveis com preços e duração.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "listar-profissionais",
    description: "Lista os profissionais disponíveis.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "consultar-horarios",
    description: "Consulta horários disponíveis para uma data específica.",
    input_schema: {
      type: "object" as const,
      properties: {
        data_consulta: { type: "string", description: "Data no formato YYYY-MM-DD" },
        profissional_id: { type: "string", description: "ID do profissional (opcional)" },
      },
      required: ["data_consulta"],
    },
  },
  {
    name: "consultar-agendamentos",
    description: "Consulta agendamentos do cliente.",
    input_schema: {
      type: "object" as const,
      properties: {
        cliente_whatsapp: { type: "string" },
        data_consulta: { type: "string" },
        data_inicio: { type: "string" },
        data_fim: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "agendar-rapido",
    description: "Cria um agendamento após confirmação explícita do cliente.",
    input_schema: {
      type: "object" as const,
      properties: {
        servico_nome: { type: "string", description: "Nome exato do serviço" },
        data: { type: "string", description: "Data no formato YYYY-MM-DD" },
        hora: { type: "string", description: "Hora no formato HH:MM" },
        cliente_nome: { type: "string" },
        cliente_whatsapp: { type: "string" },
        profissional_nome: { type: "string" },
      },
      required: ["servico_nome", "data", "hora", "cliente_nome", "cliente_whatsapp"],
    },
  },
  {
    name: "editar-agendamento",
    description: "Edita um agendamento existente. Requer appointment_id obtido via consultar-agendamentos.",
    input_schema: {
      type: "object" as const,
      properties: {
        appointment_id: { type: "string" },
        data: { type: "string" },
        hora: { type: "string" },
        profissional_nome: { type: "string" },
        servico_nome: { type: "string" },
        observacoes: { type: "string" },
      },
      required: ["appointment_id"],
    },
  },
  {
    name: "cancelar-agendamento",
    description: "Cancela um agendamento após confirmação do cliente.",
    input_schema: {
      type: "object" as const,
      properties: {
        appointment_id: { type: "string" },
      },
      required: ["appointment_id"],
    },
  },
  {
    name: "consultar-fichas",
    description: "Verifica fichas disponíveis do assinante.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
];

function buildSystemPrompt(
  ctx: Record<string, unknown>,
  userInfo: Record<string, unknown>
): string {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const dateStr = now.toLocaleDateString("pt-BR");
  const timeStr = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const weekday = now.toLocaleDateString("pt-BR", { weekday: "long" });
  const barbearia = (ctx as { barbearia?: Record<string, unknown> }).barbearia || {};
  const cliente = (ctx as { cliente?: Record<string, unknown> }).cliente || {};
  const assinatura = (ctx as { assinatura?: Record<string, unknown> }).assinatura || {};
  const agendamentos = (ctx as { agendamentos?: Record<string, unknown> }).agendamentos || {};
  const historico = (ctx as { historico?: Record<string, unknown> }).historico || {};
  const fichas = (ctx as { fichas?: Record<string, unknown> }).fichas || {};
  const preferencias = (ctx as { preferencias?: Record<string, unknown> }).preferencias || {};
  const metricas = (ctx as { metricas_ia?: Record<string, unknown> }).metricas_ia || {};

  const servicos = Array.isArray((barbearia as { servicos_disponiveis?: unknown[] }).servicos_disponiveis)
    ? (barbearia as { servicos_disponiveis: { id: string; nome: string; preco: number; duracao: number; categoria: string }[] }).servicos_disponiveis
        .map((s) => `[ID:${s.id}] ${s.nome} | R$${s.preco} | ${s.duracao}min | ${s.categoria}`)
        .join("\n")
    : "";

  const profissionais = Array.isArray((barbearia as { profissionais_disponiveis?: unknown[] }).profissionais_disponiveis)
    ? (barbearia as { profissionais_disponiveis: { nome: string; id: string; especialidade: string; disponibilidade: { data: string; dia_semana: string; horarios_disponiveis: string[] }[] }[] }).profissionais_disponiveis
        .map((p) =>
          `${p.nome} [ID:${p.id}] | ${p.especialidade}\n` +
          p.disponibilidade.map((d) =>
            `  • ${d.data} (${d.dia_semana}): ${d.horarios_disponiveis.length > 0 ? d.horarios_disponiveis.join(", ") : "sem horários"}`
          ).join("\n")
        ).join("\n\n")
    : "";

  const pagamentos = Array.isArray((userInfo as { formas_pagamento?: { label: string }[] }).formas_pagamento)
    ? (userInfo as { formas_pagamento: { label: string }[] }).formas_pagamento.map((p) => p.label).join(", ")
    : "";

  return `<identity>
Você é ${String(userInfo.nome_agente || "Assistente")}, assistente virtual da ${String(barbearia.nome_barbearia || "barbearia")}.
Seu único objetivo é ajudar clientes a agendar, consultar, remarcar ou cancelar horários usando EXCLUSIVAMENTE as tools disponíveis.
</identity>

<datetime>
Data/Hora atual: ${dateStr} ${timeStr}
Dia da semana: ${weekday}
</datetime>

<cliente>
  Nome: ${String((cliente as { nome?: string }).nome || "")}
  WhatsApp: ${String((cliente as { whatsapp?: string }).whatsapp || "")}
  É novo cliente: ${String((ctx as { cliente_novo?: boolean }).cliente_novo || false)}
  Status: ${String((cliente as { status_cliente?: string }).status_cliente || "")}

  <assinatura>
    É assinante: ${String((assinatura as { assinante?: boolean }).assinante || false)}
    Plano: ${String((assinatura as { plano_nome?: string }).plano_nome || "")}
    Tipo: ${String((assinatura as { plano_tipo?: string }).plano_tipo || "")}
    Status: ${String((assinatura as { status_assinatura?: string }).status_assinatura || "")}
    Vencimento: ${String((assinatura as { data_vencimento?: string }).data_vencimento || "")}
  </assinatura>

  <fichas>
    Disponíveis: ${String((fichas as { fichas_disponiveis?: number }).fichas_disponiveis || 0)}
    Utilizadas no mês: ${String((fichas as { fichas_utilizadas_mes?: number }).fichas_utilizadas_mes || 0)}
  </fichas>

  <agendamentos>
    Tem agendamento futuro: ${String((agendamentos as { possui_agendamento_futuro?: boolean }).possui_agendamento_futuro || false)}
    Próximo - data: ${String(((agendamentos as { proximo_agendamento?: { data?: string } }).proximo_agendamento || {}).data || "")} | hora: ${String(((agendamentos as { proximo_agendamento?: { horario?: string } }).proximo_agendamento || {}).horario || "")} | serviço: ${String(((agendamentos as { proximo_agendamento?: { servico?: string } }).proximo_agendamento || {}).servico || "")} | profissional: ${String(((agendamentos as { proximo_agendamento?: { profissional?: string } }).proximo_agendamento || {}).profissional || "")}
    Total: ${String((agendamentos as { total_agendamentos?: number }).total_agendamentos || 0)}
  </agendamentos>

  <historico>
    Último atendimento: ${String(((historico as { ultimo_atendimento?: { data?: string } }).ultimo_atendimento || {}).data || "")} | ${String(((historico as { ultimo_atendimento?: { servico?: string } }).ultimo_atendimento || {}).servico || "")}
    Total atendimentos: ${String((historico as { total_atendimentos?: number }).total_atendimentos || 0)}
    Valor total gasto: ${String((historico as { valor_total_gasto?: number }).valor_total_gasto || 0)}
  </historico>

  <preferencias>
    Profissional preferido: ${String((preferencias as { profissional_preferido?: string }).profissional_preferido || "")}
    Serviço mais usado: ${String((preferencias as { servico_mais_usado?: string }).servico_mais_usado || "")}
    Horário preferido: ${String((preferencias as { horario_preferido?: string }).horario_preferido || "")}
  </preferencias>

  <metricas>
    Cliente VIP: ${String((metricas as { cliente_vip?: boolean }).cliente_vip || false)}
    Risco de churn: ${String((metricas as { risco_churn?: string }).risco_churn || "")}
    Sugerir retorno: ${String((metricas as { sugerir_retorno?: boolean }).sugerir_retorno || false)}
    Mensagem sugerida: ${String((metricas as { sugestao_retorno_mensagem?: string }).sugestao_retorno_mensagem || "")}
  </metricas>
</cliente>

<regras_contexto>
- NUNCA peça dados que já existem no bloco <cliente> acima
- NUNCA mencione que tem acesso a dados internos do sistema
- NUNCA exiba IDs ou UUIDs ao cliente — use-os apenas internamente ao chamar tools
- Chame sempre o cliente pelo nome
</regras_contexto>

<barbearia>
  Nome: ${String(barbearia.nome_barbearia || "")}
  Endereço: ${String((barbearia as { endereco?: string }).endereco || "")}
  Telefone: ${String((barbearia as { telefone?: string }).telefone || "")}
  PIX: ${String((barbearia as { pix?: string }).pix || "")}
  Página de agendamento: ${String((barbearia as { booking_url?: string }).booking_url || "")}
  Pagamentos aceitos: ${pagamentos}

  <horarios_funcionamento>
${JSON.stringify((userInfo as { horarios_por_dia?: Record<string, string> }).horarios_por_dia || {}, null, 2)}
    Dias abertos: ${String((userInfo as { dias_abertos?: string }).dias_abertos || "")}
    Dias fechados: ${String((userInfo as { dias_fechados?: string }).dias_fechados || "")}
  </horarios_funcionamento>
</barbearia>

<servicos_disponiveis>
Use esta lista para identificar o serviço correto. Sempre use o nome EXATO.
${servicos}
</servicos_disponiveis>

<profissionais_disponiveis>
${profissionais}
</profissionais_disponiveis>

<tom_de_voz>
- Amigável, descontraído, natural de WhatsApp
- Máximo 3 linhas por resposta
- Use 1-2 emojis por mensagem
- Nunca use listas numeradas nas respostas ao cliente
- Nunca envie UUIDs ou IDs internos
</tom_de_voz>

<regras_assinantes>
Assinante ativo = assinatura.assinante = true E status_assinatura = ativo

Se hoje for sexta ou sábado E cliente for assinante ativo:
→ Diga que não atendemos assinantes hoje e ofereça outro dia.
→ Não ofereça agendamento para hoje.

Se plano_tipo = recorrente:
→ Diga que os horários já estão garantidos e pergunte se quer consultar.
→ Nunca crie agendamento manual para este tipo.

Se plano_tipo = mensal, quinzenal ou ficha:
→ Direcione para a página de agendamento de assinantes.
→ Nunca crie agendamento manual para este tipo.
</regras_assinantes>

<comportamento_inteligente>
- cliente_novo = true → Boas-vindas personalizadas na primeira mensagem
- agendamentos.possui_agendamento_futuro = true → Mencione o próximo agendamento proativamente
- metricas_ia.cliente_vip = true → Atendimento mais personalizado
- metricas_ia.risco_churn = alto → Incentive o retorno com gentileza
- metricas_ia.sugerir_retorno = true → Use a sugestao_retorno_mensagem
</comportamento_inteligente>

<proibicoes>
NUNCA faça:
- Inventar horários, preços, serviços ou profissionais
- Confirmar ação sem success: true da tool
- Exibir UUIDs ou IDs internos ao cliente
- Usar nome de serviço digitado pelo cliente — sempre use o nome exato dos serviços disponíveis
- Criar agendamento manual para assinante ativo
- Cancelar sem confirmação explícita do cliente
- Chamar tool com campos vazios, null ou undefined
</proibicoes>

<outros_contatos>
Se mencionar restaurante ou espetinho: "Para falar com o Espetae Tatuapé é só chamar: 11930588924 🍢"
Se mencionar tatuagem: "Para tatuagem, fala com a Rabiscando Tattoo: 11985408058 ✏️"
</outros_contatos>`;
}

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  userId: string,
  clienteWhatsapp: string
): Promise<unknown> {
  const base = { action: toolName, user_id: userId };

  switch (toolName) {
    case "listar-servicos":
    case "listar-profissionais":
      return callFunction("ai-agent-appointments", base);

    case "consultar-horarios":
      return callFunction("ai-agent-appointments", {
        ...base,
        data: { data_consulta: input.data_consulta, profissional_id: input.profissional_id },
      });

    case "consultar-agendamentos":
      return callFunction("ai-agent-appointments", {
        ...base,
        data: { cliente_whatsapp: clienteWhatsapp, ...input },
      });

    case "agendar-rapido":
      return callFunction("ai-agent-appointments", { ...base, data: input });

    case "editar-agendamento": {
      const { appointment_id, ...rest } = input;
      return callFunction("ai-agent-appointments", {
        ...base,
        appointment_id,
        data: rest,
      });
    }

    case "cancelar-agendamento":
      return callFunction("ai-agent-appointments", {
        ...base,
        appointment_id: input.appointment_id,
      });

    case "consultar-fichas":
      return callFunction("ai-agent-appointments", {
        ...base,
        cliente_whatsapp: clienteWhatsapp,
      });

    default:
      return { error: "Tool desconhecida" };
  }
}

export async function runAgent(params: {
  messages: string[];
  history: Anthropic.MessageParam[];
  userId: string;
  clienteWhatsapp: string;
  clienteNome: string;
  context: Record<string, unknown>;
  userInfo: Record<string, unknown>;
}): Promise<string> {
  const { messages, history, userId, clienteWhatsapp, context, userInfo } = params;

  const userText = messages.join("\n");
  const systemPrompt = buildSystemPrompt(context, userInfo);

  const conversationMessages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userText },
  ];

  let response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    tools: TOOLS,
    messages: conversationMessages,
  });

  // Agentic loop
  while (response.stop_reason === "tool_use") {
    const assistantMsg: Anthropic.MessageParam = {
      role: "assistant",
      content: response.content,
    };

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const result = await executeTool(
        block.name,
        block.input as Record<string, unknown>,
        userId,
        clienteWhatsapp
      );

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    conversationMessages.push(assistantMsg);
    conversationMessages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages: conversationMessages,
    });
  }

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock ? (textBlock as Anthropic.TextBlock).text : "";
}
