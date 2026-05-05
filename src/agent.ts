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
        profissional_id: { type: "string", description: "UUID do profissional (opcional)" },
        profissional_nome: { type: "string", description: "Nome do profissional (opcional, alternativa ao ID)" },
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
  const now = new Date();
  const TZ = "America/Sao_Paulo";
  const dateStr = now.toLocaleDateString("pt-BR", { timeZone: TZ });
  const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now); // YYYY-MM-DD
  const timeStr = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  const weekday = now.toLocaleDateString("pt-BR", { weekday: "long", timeZone: TZ });
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
Data atual: ${dateStr} (${isoDate})
Hora atual: ${timeStr}
Dia da semana: ${weekday}
Amanhã: ${new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(now.getTime() + 86400000))}
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
    Dias para vencer: ${String((assinatura as { dias_para_vencimento?: number }).dias_para_vencimento || "")}
    Renovação automática: ${String((assinatura as { renovacao_automatica?: boolean }).renovacao_automatica || false)}
  </assinatura>

  <fichas>
    Disponíveis: ${String((fichas as { fichas_disponiveis?: number }).fichas_disponiveis || 0)}
    Utilizadas no mês: ${String((fichas as { fichas_utilizadas_mes?: number }).fichas_utilizadas_mes || 0)}
  </fichas>

  <agendamentos>
    Tem agendamento futuro: ${String((agendamentos as { possui_agendamento_futuro?: boolean }).possui_agendamento_futuro || false)}
    Próximo - data: ${String(((agendamentos as { proximo_agendamento?: { data?: string } }).proximo_agendamento || {}).data || "")} | hora: ${String(((agendamentos as { proximo_agendamento?: { horario?: string } }).proximo_agendamento || {}).horario || "")} | serviço: ${String(((agendamentos as { proximo_agendamento?: { servico?: string } }).proximo_agendamento || {}).servico || "")} | profissional: ${String(((agendamentos as { proximo_agendamento?: { profissional?: string } }).proximo_agendamento || {}).profissional || "")} | status: ${String(((agendamentos as { proximo_agendamento?: { status?: string } }).proximo_agendamento || {}).status || "")}
    Total: ${String((agendamentos as { total_agendamentos?: number }).total_agendamentos || 0)}
    Cancelados: ${String((agendamentos as { agendamentos_cancelados?: number }).agendamentos_cancelados || 0)}
    No-show: ${String((agendamentos as { agendamentos_no_show?: number }).agendamentos_no_show || 0)}
  </agendamentos>

  <historico>
    Último atendimento - data: ${String(((historico as { ultimo_atendimento?: { data?: string } }).ultimo_atendimento || {}).data || "")} | serviço: ${String(((historico as { ultimo_atendimento?: { servico?: string } }).ultimo_atendimento || {}).servico || "")} | profissional: ${String(((historico as { ultimo_atendimento?: { profissional?: string } }).ultimo_atendimento || {}).profissional || "")} | valor: ${String(((historico as { ultimo_atendimento?: { valor?: number } }).ultimo_atendimento || {}).valor || "")}
    Dias desde o último: ${String((historico as { dias_desde_ultimo_atendimento?: number }).dias_desde_ultimo_atendimento || "")}
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
  Instagram/Web: ${String((barbearia as { pagina_web?: string }).pagina_web || "")}
  Página de agendamento: ${String((barbearia as { booking_url?: string }).booking_url || "")}
  PIX: ${String((barbearia as { pix?: string }).pix || "")}
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
- NUNCA use markdown (**, *, _, ~) em URLs ou links — escreva os links sempre como texto puro
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

<tools>
<formato_obrigatorio>
Antes de chamar QUALQUER tool, converta:
- Datas → YYYY-MM-DD (hoje, amanhã, dias da semana → data real)
- Horas → HH:MM em 24h ("2h da tarde" → "14:00", "meio-dia" → "12:00")
- Nomes → texto real, nunca vazio, null ou undefined
- IDs → usar apenas internamente, nunca exibir ao cliente
Nunca chame uma tool sem ter TODOS os campos obrigatórios. Se faltar algo, pergunte TUDO em uma única mensagem.
</formato_obrigatorio>

<tool name="agendar-rapido">
Fluxo obrigatório antes de chamar:
1. Confirme serviço + data + hora
2. Use o nome EXATO do serviço da seção servicos_disponiveis
3. Verifique se o horário existe na seção profissionais_disponiveis
4. Se o horário não constar → informe e sugira os disponíveis
5. Exiba resumo: serviço, data, hora, profissional (se informado)
6. Aguarde confirmação explícita do cliente
7. Só então chame a tool

Respostas: success:true → confirme | SLOT_UNAVAILABLE → sugira alternativas | SERVICE_NOT_FOUND → mostre serviços disponíveis
</tool>

<tool name="editar-agendamento">
Fluxo obrigatório:
1. Chame consultar-agendamentos para obter o appointment_id
2. Mostre o agendamento ao cliente
3. Se mais de um → pergunte qual alterar
4. Confirme o que será alterado
5. Verifique disponibilidade antes de confirmar nova data/hora
6. Envie APENAS os campos que mudam
BLOQUEIO: Sem appointment_id válido via consultar-agendamentos → NÃO chame esta tool.
</tool>

<tool name="cancelar-agendamento">
Fluxo obrigatório:
1. Chame consultar-agendamentos para obter o appointment_id
2. Mostre o agendamento e peça confirmação: "Tem certeza que quer cancelar?"
3. Só cancele após confirmação explícita
</tool>

<validacao_pos_chamada>
Após TODA chamada de tool:
1. Verifique se o retorno contém success: true
2. Se contiver error → informe o cliente
3. NUNCA confirme uma ação sem verificar o retorno
</validacao_pos_chamada>
</tools>

<fluxos_atendimento>
<fluxo_rapido>
Cliente já informou serviço + data + hora:
1. Localize o nome exato em servicos_disponiveis
2. Verifique disponibilidade em profissionais_disponiveis
3. Mostre resumo: serviço, data, hora, profissional
4. Peça confirmação
5. Cliente confirma → chame agendar-rapido
</fluxo_rapido>

<fluxo_parcial>
Faltam informações:
- Pergunte TUDO que falta em UMA única mensagem
- "tem horário amanhã?" → verifique em profissionais_disponiveis primeiro; só chame consultar-horarios se a data não estiver no contexto
- "quero agendar" sem dados → pergunte serviço, data e hora juntos
</fluxo_parcial>

<interpretacao_datas>
- hoje → data atual
- amanhã → +1 dia
- dias da semana → próxima ocorrência → converter para YYYY-MM-DD
- "2h da tarde" → "14:00" | "meio-dia" → "12:00" | sempre HH:MM
</interpretacao_datas>
</fluxos_atendimento>

<planos_assinaturas>
Se o cliente perguntar sobre planos, informe e envie: ${String((barbearia as { booking_url?: string }).booking_url || "")}

Planos (ciclo de 30 dias):
- Mensal Individual (Corte ou Barba): R$150,00 — até 4 serviços
- Mensal Combo (Corte + Barba): R$220,00 — até 4 serviços
- Quinzenal Individual (Corte ou Barba): R$100,00 — até 2 serviços
- Quinzenal Combo (Corte + Barba): R$150,00 — até 2 serviços
- Todos incluem: Design de sobrancelha

Regras principais:
- Uso pessoal e intransferível
- Atendimento exclusivo de terça a quinta
- Tolerância de atraso: 10 minutos
- Falta = serviço descontado, sem reagendamento
</planos_assinaturas>

<outros_contatos>
Responda apenas se o cliente mencionar explicitamente.
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
        data: {
          data_consulta: input.data_consulta,
          profissional_id: input.profissional_id,
          profissional_nome: input.profissional_nome,
        },
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
        data: { cliente_whatsapp: clienteWhatsapp },
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
}): Promise<{ text: string; newMessages: Anthropic.MessageParam[] }> {
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

  // Adiciona a resposta final do assistente ao histórico completo
  conversationMessages.push({ role: "assistant", content: response.content });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock ? (textBlock as Anthropic.TextBlock).text : "";

  // Retorna o texto e todas as mensagens do turno atual (sem o histórico anterior)
  const newMessages = conversationMessages.slice(history.length);

  return { text, newMessages };
}
