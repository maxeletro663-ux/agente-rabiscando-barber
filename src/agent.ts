import Anthropic from "@anthropic-ai/sdk";
import { callFunction, getCustomerContext } from "./services/supabase";
import { callLLM } from "./services/llm";

const TZ = "America/Sao_Paulo";
// Chaves SEM acento — mesmo formato de horarios_por_dia retornado pela edge function
const DIAS_KEYS = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const DIAS_NOMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

type HorarioDia = { fechado?: boolean; abertura?: string; fechamento?: string };

// Dia da semana de uma data YYYY-MM-DD, determinístico (independe do fuso do servidor)
function dayIndexOf(isoDate: string): number {
  return new Date(isoDate + "T12:00:00Z").getUTCDay();
}

function getHorariosPorDia(userInfo: Record<string, unknown>): Record<string, HorarioDia> {
  const h = (userInfo as { horarios_por_dia?: Record<string, HorarioDia> }).horarios_por_dia;
  return h && typeof h === "object" ? h : {};
}

// Blindagem determinística: se a data cai em dia fechado da barbearia, retorna a
// resposta CLOSED_DAY localmente (mesmo shape da edge function), sem chamar a API.
// Retorna null se o dia está aberto ou se não há dados para validar.
export function closedDayGuard(
  isoDate: unknown,
  userInfo: Record<string, unknown>
): Record<string, unknown> | null {
  if (typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const horarios = getHorariosPorDia(userInfo);
  if (Object.keys(horarios).length === 0) return null; // sem dados — deixa a edge validar
  const idx = dayIndexOf(isoDate);
  const dia = horarios[DIAS_KEYS[idx]];
  if (!dia || dia.fechado !== true) return null;
  const diasAbertos = DIAS_KEYS
    .map((k, i) => ({ k, i }))
    .filter(({ k }) => horarios[k] && horarios[k].fechado !== true)
    .map(({ i }) => DIAS_NOMES[i])
    .join(", ");
  return {
    success: false,
    type: "CLOSED_DAY",
    data: isoDate,
    dia_semana: DIAS_NOMES[idx],
    horarios_disponiveis: [],
    horarios_ocupados: [],
    dias_abertos: diasAbertos,
    message: `ATENÇÃO: A barbearia NÃO funciona na ${DIAS_NOMES[idx]}. Esta data NÃO está disponível para agendamento. Os dias de funcionamento são: ${diasAbertos}. Sugira ao cliente uma data em um destes dias.`,
  };
}

// Veredito único de assinatura — a fonte da verdade é o boolean `assinante`.
// Ex-assinantes vêm com plano_nome/data_vencimento residuais (do plano antigo),
// o que confundia o modelo se ele reclassificasse por conta própria.
function isAssinanteAtivo(ctx: Record<string, unknown>): boolean {
  const assinatura = (ctx as { assinatura?: Record<string, unknown> }).assinatura || {};
  const assinanteBool = (assinatura as { assinante?: boolean }).assinante === true;
  const statusAss = String((assinatura as { status_assinatura?: string }).status_assinatura || "").toLowerCase();
  return assinanteBool && (statusAss === "ativo" || statusAss === "ativa");
}

// Só o plano RECORRENTE tem sessões pré-criadas (6 meses de agendamento no
// mesmo dia/horário) — esse é o que não pode reagendar. O plano por FICHAS não
// tem agendamento pré-estabelecido: o cliente agenda normalmente e desconta
// uma ficha, então não entra nesse bloqueio.
// Quem diz isso é `modo_utilizacao` ("recorrente" | "fichas"), escolhido na
// contratação. `plano_tipo` é "mensal"/"quinzenal" e NUNCA vale "recorrente" —
// de 09/08 a 07/10/2026 a trava comparava plano_tipo e não bloqueava ninguém.
function isAssinanteRecorrente(ctx: Record<string, unknown>): boolean {
  if (!isAssinanteAtivo(ctx)) return false;
  const assinatura = (ctx as { assinatura?: Record<string, unknown> }).assinatura || {};
  const modo = String((assinatura as { modo_utilizacao?: string }).modo_utilizacao || "").toLowerCase();
  if (modo) return modo === "recorrente";
  // Contexto antigo (sem modo_utilizacao): renovação automática só existe no recorrente
  return (assinatura as { renovacao_automatica?: boolean }).renovacao_automatica === true;
}

function modoPlanoLabel(ctx: Record<string, unknown>): string {
  return isAssinanteRecorrente(ctx) ? "RECORRENTE" : "FICHAS";
}

// Blindagem determinística: NENHUM assinante ativo reagenda pelo chat —
// recorrente (sessões pré-agendadas) nem fichas (decisão do Renan, 07/10/2026).
// A diferença entre os dois fica só no agendamento NOVO: fichas agenda pelo
// chat, recorrente é direcionado à página. Bloqueia antes de chamar a edge
// function, independente do que o modelo decidir.
function assinanteRescheduleGuard(context: Record<string, unknown>): Record<string, unknown> | null {
  if (!isAssinanteAtivo(context)) return null;
  return {
    success: false,
    type: "SUBSCRIBER_RESCHEDULE_BLOCKED",
    message:
      "Assinantes não podem reagendar pelo chat — as sessões já vêm pré-agendadas para manter a organização da agenda. NÃO ofereça horários alternativos. Explique isso educadamente ao cliente e, se ele realmente precisar mudar, oriente a falar diretamente com a barbearia.",
  };
}

// Blindagem determinística: nunca deixa passar um nome vazio ou genérico pro
// agendamento. Campo obrigatório demais fica tentador pro modelo "inventar"
// algo como "Cliente" só pra completar a chamada em vez de perguntar.
const NOME_GENERICO_REGEX = /^(cliente|cliente novo|novo cliente|usu[aá]rio|desconhecido|sem nome|n\/?a|test[e]?)$/i;

function nomeGenericoGuard(nome: unknown): Record<string, unknown> | null {
  const n = String(nome ?? "").trim();
  if (!n || NOME_GENERICO_REGEX.test(n)) {
    return {
      success: false,
      type: "MISSING_CLIENT_NAME",
      message:
        "O nome do cliente está vazio ou é um placeholder genérico (ex: 'Cliente'). NÃO chame esta tool com um nome inventado — pergunte o nome real do cliente antes de agendar.",
    };
  }
  return null;
}

interface ProfDisponibilidade {
  nome: string;
  id: string;
  especialidade: string;
  disponibilidade: { data: string; dia_semana: string; horarios_disponiveis: string[] }[];
}

// Se a edge function falhar, tenta deduzir a disponibilidade real pelos dados já
// presentes no contexto (ai-customer-context traz disponibilidade por profissional).
// Evita que uma falha técnica vire um "não tem horário" para o cliente.
export function contextFallbackHorarios(
  context: Record<string, unknown>,
  profissionalId: string | undefined,
  profissionalNome: string | undefined,
  dataConsulta: string
): unknown | null {
  const barbearia = (context.barbearia || {}) as Record<string, unknown>;
  const profs = Array.isArray(barbearia.profissionais_disponiveis)
    ? (barbearia.profissionais_disponiveis as ProfDisponibilidade[])
    : [];

  const candidatos = profs.filter(
    (p) =>
      Array.isArray(p.disponibilidade) &&
      ((profissionalId && p.id === profissionalId) ||
        (profissionalNome && p.nome.toLowerCase().includes(profissionalNome.toLowerCase())) ||
        (!profissionalId && !profissionalNome))
  );

  if (candidatos.length === 0) return null; // nada no contexto — não dá para inferir

  const porProfissional = candidatos.map((prof) => {
    const diaEntry = prof.disponibilidade.find((d) => d.data === dataConsulta);
    // Data ausente da disponibilidade → profissional não trabalha nesse dia (folga)
    // Data presente mas lista vazia → sem slots (totalmente ocupado)
    return {
      profissional_id: prof.id,
      profissional_nome: prof.nome,
      horarios_disponiveis: diaEntry ? diaEntry.horarios_disponiveis : [],
      horarios_ocupados: [],
    };
  });

  console.log(
    `[consultar-horarios] fallback contexto: ${candidatos.map((p) => p.nome).join(", ")} em ${dataConsulta}`
  );
  return {
    success: true,
    data: dataConsulta,
    horarios_disponiveis: porProfissional.flatMap((p) => p.horarios_disponiveis),
    horarios_por_profissional: porProfissional,
    horarios_ocupados: [],
    _source: "context_fallback",
  };
}

// Resolve servico_id a partir do nome (ou valida um id) usando a lista de
// serviços do contexto. Sem servico_id a edge calcula a lista por fatias de
// 30 min e um serviço de 60 min pode "caber" na lista mas dar 409 na hora
// de agendar/editar.
function resolveServicoId(
  context: Record<string, unknown>,
  servicoId: unknown,
  servicoNome: unknown
): string | undefined {
  const barbearia = (context.barbearia || {}) as Record<string, unknown>;
  const servicos = Array.isArray(barbearia.servicos_disponiveis)
    ? (barbearia.servicos_disponiveis as { id?: string; nome?: string }[])
    : [];
  const id = String(servicoId ?? "").trim();
  if (id && servicos.some((s) => s.id === id)) return id;
  const nome = String(servicoNome ?? "").trim().toLowerCase();
  if (!nome) return undefined;
  const exato = servicos.find((s) => String(s.nome ?? "").toLowerCase() === nome);
  if (exato?.id) return exato.id;
  const parcial = servicos.filter(
    (s) => String(s.nome ?? "").toLowerCase().includes(nome) || nome.includes(String(s.nome ?? "").toLowerCase())
  );
  return parcial.length === 1 ? parcial[0].id : undefined;
}

// Última linha de defesa: nada de raciocínio interno, código de erro ou nome
// de tool chega ao cliente. Se a resposta final vazou algo assim, troca por
// uma mensagem neutra e loga o texto original pra diagnóstico.
const LEAK_PATTERNS: RegExp[] = [
  /\berro\s*\d{3}\b/i,                                   // "erro 409", "erro 500"
  /\b(status|c[oó]digo)\s*\d{3}\b/i,
  /\b(tool|ferramenta|fun[cç][aã]o|edge function|api|endpoint|json|payload|webhook)\b/i,
  /\b(consultar|listar|agendar|editar|cancelar)-[a-z-]+/i, // nomes das tools
  /\b(servico|servi[cç]o|appointment|profissional|cliente|user)_(id|nome|whatsapp)\b/i,
  /\bsuccess\s*[:=]/i,
  /\b(deixa|deixe)\s+eu\s+(verificar|checar|tentar|ver)\b/i,
  /\bvou\s+(tentar|verificar|checar)\s+(novamente|de novo|outra abordagem|outra forma)/i,
  /\boutra abordagem\b/i,
  /\bo retorno (da|do|de)\b/i,
  /\bn[aã]o tenho como passar\b/i,
  /\bfatias? de \d+ ?min/i,
  /\bpar[aâ]metro\b/i,
];

export function sanitizeReply(text: string): { text: string; leaked: boolean } {
  const t = (text || "").trim();
  if (!t) return { text: "", leaked: false };
  const leaked = LEAK_PATTERNS.some((re) => re.test(t));
  return leaked ? { text: LEAK_FALLBACK, leaked: true } : { text: t, leaked: false };
}

const LEAK_FALLBACK =
  "Opa, tive uma instabilidade aqui pra concluir isso 😅 Pode me dizer de novo o que você precisa? Se preferir, dá pra agendar direto pela nossa página também.";

// Limite de rodadas de tool por turno. Sem isso, um retorno inesperado pode
// virar tentativa atrás de tentativa até o modelo desistir narrando o problema.
const MAX_TOOL_ROUNDS = 8;

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
    description: "Consulta horários disponíveis para uma data específica. SEMPRE informe servico_nome (ou servico_id) quando já souber o serviço — sem ele a lista vem em fatias de 30 min e um serviço mais longo pode não caber no horário.",
    input_schema: {
      type: "object" as const,
      properties: {
        data_consulta: { type: "string", description: "Data no formato YYYY-MM-DD" },
        profissional_id: { type: "string", description: "UUID do profissional (opcional)" },
        profissional_nome: { type: "string", description: "Nome do profissional (opcional, alternativa ao ID)" },
        servico_nome: { type: "string", description: "Nome EXATO do serviço (de servicos_disponiveis) — para receber só os horários em que o serviço cabe inteiro" },
        servico_id: { type: "string", description: "ID do serviço (alternativa a servico_nome)" },
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
    description: "Cria agendamento para o PRÓPRIO cliente (titular). ⛔ PROIBIDO usar quando o assinante está agendando para outra pessoa (filho, esposa, familiar) — nesses casos use OBRIGATORIAMENTE agendar-para-terceiro.",
    input_schema: {
      type: "object" as const,
      properties: {
        servico_nome: { type: "string", description: "Nome exato do serviço" },
        data: { type: "string", description: "Data no formato YYYY-MM-DD" },
        hora: { type: "string", description: "Hora no formato HH:MM" },
        cliente_nome: { type: "string", description: "Nome do cliente — use cliente.nome do contexto se disponível; só pergunte se cliente_novo=true e nome estiver vazio" },
        cliente_whatsapp: { type: "string", description: "WhatsApp do cliente — use SEMPRE o valor de cliente.whatsapp do contexto; NUNCA peça ao cliente" },
        profissional_nome: { type: "string" },
        observacoes: { type: "string", description: "Observação opcional" },
      },
      required: ["servico_nome", "data", "hora", "cliente_nome", "cliente_whatsapp"],
    },
  },
  {
    name: "agendar-para-terceiro",
    description: "Cria agendamento AVULSO (sem ficha) para familiar/terceiro a pedido de um assinante. O agendamento fica no nome do ASSINANTE (titular), mas a observação registra quem será atendido. NUNCA passar cliente_whatsapp para não consumir ficha.",
    input_schema: {
      type: "object" as const,
      properties: {
        servico_nome: { type: "string", description: "Nome exato do serviço" },
        data: { type: "string", description: "Data no formato YYYY-MM-DD" },
        hora: { type: "string", description: "Hora no formato HH:MM" },
        cliente_nome: { type: "string", description: "Nome do ASSINANTE (titular da conta) — use o valor de cliente.nome do contexto" },
        profissional_nome: { type: "string" },
        observacoes: { type: "string", description: "Nome de quem será atendido: ex 'Agendamento para: João (filho do assinante Alan)'" },
      },
      required: ["servico_nome", "data", "hora", "cliente_nome", "observacoes"],
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

export function buildSystemPrompt(
  ctx: Record<string, unknown>,
  userInfo: Record<string, unknown>
): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("pt-BR", { timeZone: TZ });
  const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now); // YYYY-MM-DD
  const timeStr = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  const weekday = now.toLocaleDateString("pt-BR", { weekday: "long", timeZone: TZ });

  // Calendário pré-computado dos próximos 14 dias — evita que o modelo erre a
  // conversão de "quinta", "próxima terça" etc. para a data real (YYYY-MM-DD).
  // Cada linha já vem anotada com aberto/fechado, para o modelo não precisar
  // cruzar o calendário com horarios_funcionamento por conta própria.
  const horariosPorDia = getHorariosPorDia(userInfo);
  const dias14 = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now.getTime() + i * 86400000);
    const iso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
    const wd = d.toLocaleDateString("pt-BR", { weekday: "long", timeZone: TZ });
    const dia = horariosPorDia[DIAS_KEYS[dayIndexOf(iso)]];
    return { i, iso, wd, dia };
  });
  const calendario = dias14.map(({ i, iso, wd, dia }) => {
    const tag = i === 0 ? "  ← HOJE" : i === 1 ? "  ← AMANHÃ" : "";
    const status = !dia
      ? ""
      : dia.fechado === true
        ? "  ⛔ FECHADO — NÃO ofereça nem aceite esta data"
        : `  (aberto ${dia.abertura || "?"}–${dia.fechamento || "?"})`;
    return `  ${iso} = ${wd}${tag}${status}`;
  }).join("\n");

  // Situação de hoje + próximo dia aberto pré-computados — evita que o modelo
  // chame de "amanhã" um dia de reabertura que não é amanhã (ex.: domingo e
  // segunda fechados → reabre terça, que NÃO é amanhã).
  const hoje14 = dias14[0];
  const hojeAberto = hoje14.dia ? hoje14.dia.fechado !== true : null;
  const proximoAberto = dias14.find(({ i, dia }) => i > 0 && dia && dia.fechado !== true);
  const situacaoHoje = hojeAberto === null
    ? ""
    : hojeAberto
      ? `HOJE está ABERTO (${hoje14.dia?.abertura || "?"}–${hoje14.dia?.fechamento || "?"}).`
      : proximoAberto
        ? `HOJE está FECHADO (${hoje14.wd}). Próximo dia aberto: ${proximoAberto.wd} (${proximoAberto.iso}), a partir das ${proximoAberto.dia?.abertura || "?"}.${
            proximoAberto.i === 1
              ? " Esse dia É amanhã."
              : ` ⚠️ Esse dia NÃO é amanhã — ao citá-lo diga "na ${proximoAberto.wd}", NUNCA "amanhã".`
          }`
        : `HOJE está FECHADO (${hoje14.wd}).`;
  const barbearia = (ctx as { barbearia?: Record<string, unknown> }).barbearia || {};
  const cliente = (ctx as { cliente?: Record<string, unknown> }).cliente || {};
  const assinatura = (ctx as { assinatura?: Record<string, unknown> }).assinatura || {};
  const agendamentos = (ctx as { agendamentos?: Record<string, unknown> }).agendamentos || {};
  const historico = (ctx as { historico?: Record<string, unknown> }).historico || {};
  const fichas = (ctx as { fichas?: Record<string, unknown> }).fichas || {};
  const preferencias = (ctx as { preferencias?: Record<string, unknown> }).preferencias || {};
  const metricas = (ctx as { metricas_ia?: Record<string, unknown> }).metricas_ia || {};

  // Resolvido no código (não pelo modelo) para não reclassificar assinante por
  // conta própria a partir de dados residuais de plano antigo.
  const assinanteBool = (assinatura as { assinante?: boolean }).assinante === true;
  const statusAss = String((assinatura as { status_assinatura?: string }).status_assinatura || "").toLowerCase();
  const assinaturaAtiva = isAssinanteAtivo(ctx);
  const assinanteRecorrente = isAssinanteRecorrente(ctx);
  const fluxoAssinante = assinaturaAtiva
    ? assinanteRecorrente
      ? "ASSINANTE ATIVO (plano RECORRENTE) — siga o CASO 1 de <regras_assinantes>. Para o próprio assinante: direcione à página de assinante (sessões já pré-agendadas, NÃO agende nem reagende manualmente). Para terceiro: use agendar-para-terceiro."
      : "ASSINANTE ATIVO (plano por FICHAS) — siga o CASO 1 de <regras_assinantes>. Para o próprio assinante: agende normalmente pelo chat com agendar-rapido (ficha descontada automaticamente pelo sistema). Para terceiro: use agendar-para-terceiro."
    : assinanteBool
      ? `ASSINATURA ${(statusAss || "inativa").toUpperCase()} — siga o CASO 2: informe que a assinatura não está ativa e ofereça renovar OU agendar avulso.`
      : "NÃO É ASSINANTE — siga o CASO 3: agende normalmente pelo chat como cliente avulso (preço normal). NUNCA direcione à página de assinante, NUNCA mencione fichas, NUNCA trate como assinante, mesmo que apareçam dados de plano antigo.";

  const servicos = Array.isArray((barbearia as { servicos_disponiveis?: unknown[] }).servicos_disponiveis)
    ? (barbearia as { servicos_disponiveis: { id: string; nome: string; preco: number; duracao: number; categoria: string }[] }).servicos_disponiveis
        .map((s) => `[ID:${s.id}] ${s.nome} | R$${s.preco} | ${s.duracao}min | ${s.categoria}`)
        .join("\n")
    : "";

  // Apenas nome + especialidade. NÃO injetamos horários por dia aqui de
  // propósito: eles ficam desatualizados e o modelo acaba apresentando horários
  // ocupados. A disponibilidade real vem SEMPRE da tool consultar-horarios.
  const profissionais = Array.isArray((barbearia as { profissionais_disponiveis?: unknown[] }).profissionais_disponiveis)
    ? (barbearia as { profissionais_disponiveis: { nome: string; id: string; especialidade: string }[] }).profissionais_disponiveis
        .map((p) => `${p.nome} [ID:${p.id}] | ${p.especialidade}`)
        .join("\n")
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
${situacaoHoje ? `⚠️ ${situacaoHoje}\n` : ""}
⚠️ Para converter QUALQUER referência a dia da semana ("quinta", "próxima terça", "sábado") em data, use EXCLUSIVAMENTE a tabela abaixo. NUNCA calcule a data de cabeça — isso causa erros. Localize o dia da semana na tabela e use o YYYY-MM-DD correspondente (a próxima ocorrência a partir de hoje).
⚠️ Cada linha já indica se a barbearia está ABERTA ou FECHADA naquela data. Linha marcada "⛔ FECHADO" = NUNCA ofereça, sugira ou aceite essa data; informe imediatamente os dias em que a barbearia abre. Linha com "(aberto HH:MM–HH:MM)" = dia válido para agendamento dentro desse horário:
<calendario>
${calendario}
</calendario>
</datetime>

<cliente>
  Nome: ${String((cliente as { nome?: string }).nome || "")}
  WhatsApp: ${String((cliente as { whatsapp?: string }).whatsapp || "")}
  É novo cliente: ${String((ctx as { cliente_novo?: boolean }).cliente_novo || false)}
  Status: ${String((cliente as { status_cliente?: string }).status_cliente || "")}
  Bloqueado: ${String((cliente as { bloqueado?: boolean }).bloqueado || false)}

  <assinatura>
    ⚠️ VEREDITO (use este, não interprete por conta própria): ${fluxoAssinante}
    É assinante: ${assinanteBool}${assinanteBool ? `
    Plano: ${String((assinatura as { plano_nome?: string }).plano_nome || "")}
    Tipo: ${String((assinatura as { plano_tipo?: string }).plano_tipo || "")}
    Modo do plano: ${modoPlanoLabel(ctx)}
    Status: ${statusAss}
    Vencimento: ${String((assinatura as { data_vencimento?: string }).data_vencimento || "")}
    Dias para vencer: ${String((assinatura as { dias_para_vencimento?: number }).dias_para_vencimento || "")}
    Renovação automática: ${String((assinatura as { renovacao_automatica?: boolean }).renovacao_automatica || false)}` : `
    (cliente avulso — sem plano ativo; ignore quaisquer dados de plano antigo)`}
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
- cliente.whatsapp: use SEMPRE este valor ao chamar tools — JAMAIS peça o número ao cliente
- cliente.nome: se não estiver vazio, use-o diretamente — só pergunte o nome se cliente_novo=true E nome estiver em branco
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
Esta lista serve SOMENTE para saber quais profissionais existem no estabelecimento.
Para saber dias e horários em que cada um atende, SEMPRE chame a tool consultar-horarios — ela retorna a disponibilidade real por profissional para a data pedida.
NUNCA invente ou suponha horários: se ainda não chamou consultar-horarios, chame antes de responder.
${profissionais}
</profissionais_disponiveis>

<tom_de_voz>
- Amigável, descontraído, natural de WhatsApp
- Máximo 3 linhas por resposta
- Use 1-2 emojis por mensagem
- Nunca use listas numeradas nas respostas ao cliente
- Nunca envie UUIDs ou IDs internos
- NUNCA use markdown (**, *, _, ~) em URLs ou links — escreva os links sempre como texto puro
- ⚠️ PENSE ANTES DE ESCREVER: sua resposta é enviada ao cliente exatamente como você escreve, dividida em mensagens por parágrafo. Decida TUDO (consultar <calendario>, verificar dias fechados) ANTES de começar o texto e escreva SOMENTE a conclusão final, em UM único parágrafo coeso.
- NUNCA raciocine em voz alta: nada de perguntas retóricas a si mesmo ("A gente abre amanhã? Não, também fechamos!"), nada de se corrigir no meio da resposta. Se pegou uma informação errada, reescreva mentalmente — o cliente só pode ver a versão final correta.
- ⛔ O cliente NÃO sabe que existem tools, retornos, campos ou erros. NUNCA escreva pra ele coisas como "erro 409", "conflito", "a edição está retornando erro", "deixa eu verificar", "vou tentar outra abordagem", "não tenho como passar o servico_id", "o retorno da consulta indicou". Se algo deu errado, diga em UMA frase simples o que o cliente precisa saber (ex.: "Esse horário não comporta o serviço 😅 Tenho 14:00 ou 15:30, qual prefere?") e pare.
</tom_de_voz>

<regras_assinantes>
⚠️ REGRA PRIORITÁRIA — execute ANTES de qualquer fluxo de agendamento:

O bloco <assinatura> acima já traz um VEREDITO pronto indicando qual CASO seguir. OBEDEÇA o VEREDITO — não reclassifique o cliente por conta própria a partir de plano_nome, vencimento ou histórico. Se o VEREDITO disser "NÃO É ASSINANTE", trate como cliente avulso comum mesmo que existam dados de um plano antigo.

Sempre que o cliente demonstrar interesse em agendar (ex: "quero cortar", "tem horário", "quero marcar", "quando tem vaga" etc.), siga o VEREDITO do bloco <assinatura> antes de responder sobre horários ou serviços.

━━━ CASO 1: assinante = true E status_assinatura = ativo ━━━
→ Primeiro identifique: o agendamento é para o PRÓPRIO assinante ou para OUTRA PESSOA?

SE FOR PARA O PRÓPRIO ASSINANTE, verifique o campo "Modo do plano" do bloco <assinatura> (NÃO use "Tipo", que é só mensal/quinzenal):

  → Modo do plano = RECORRENTE (sessões já pré-agendadas, 6 meses, mesmo dia/horário):
  → NÃO prossiga com agendamento manual
  → Diga: "Como assinante, é só acessar ${String((barbearia as { booking_url?: string }).booking_url || "")}, clicar em *Serviço Assinantes*, colocar seu número e escolher a data e horário 😊"

  → Modo do plano = FICHAS (sem sessão pré-agendada):
  → Agende normalmente pelo chat, igual um cliente avulso: confirme disponibilidade com consultar-horarios e use agendar-rapido — a ficha é descontada automaticamente pelo sistema, não precisa mencionar isso ao cliente nem calcular manualmente

SE FOR PARA OUTRA PESSOA (filho, esposa, familiar, amigo etc.):
→ É agendamento AVULSO — preço normal, SEM consumir ficha
→ Pergunte o nome de quem vai ser atendido e qual a relação
→ Use OBRIGATORIAMENTE a tool **agendar-para-terceiro** (NUNCA agendar-rapido):
   cliente_nome = nome do ASSINANTE (titular) — valor exato de cliente.nome do contexto
   ⚠️ NÃO incluir cliente_whatsapp
   observacoes = "Agendamento para: [nome] ([relação]) — solicitado pelo assinante [nome_assinante]"
   Exemplo: observacoes = "Agendamento para: João (filho) — solicitado pelo assinante Alan"

━━━ CASO 2: assinante = true E status_assinatura ≠ ativo (vencida, cancelada etc.) ━━━
→ Informe que a assinatura está vencida/inativa
→ Ofereça duas opções:
   1. Renovar o plano pela página: ${String((barbearia as { booking_url?: string }).booking_url || "")}
   2. Agendar avulso normalmente pelo chat
→ Aguarde a escolha do cliente antes de prosseguir

━━━ CASO 3: assinante = false (não é assinante) ━━━
→ Prossiga normalmente com o fluxo de agendamento

━━━ REGRAS ADICIONAIS PARA ASSINANTES ATIVOS ━━━
→ Sexta ou sábado: assinantes não são atendidos nestes dias — informe e sugira outro dia
→ Modo do plano = RECORRENTE: horários já garantidos automaticamente — não crie agendamento manual
→ ⛔ NENHUM assinante ativo (RECORRENTE ou FICHAS) PODE reagendar pelo chat. Se pedir para mudar dia/horário de um atendimento já marcado, NÃO chame consultar-horarios nem editar-agendamento — explique educadamente que assinantes não remarcam pelo chat e, se for realmente necessário, oriente a falar diretamente com a barbearia.
→ Assinante por FICHAS pode fazer agendamento NOVO pelo chat normalmente (descontando ficha), só não remarca o que já está marcado.
</regras_assinantes>

<comportamento_inteligente>
- cliente_novo = true → Boas-vindas personalizadas na primeira mensagem
- agendamentos.possui_agendamento_futuro = true → Mencione o próximo agendamento proativamente
- metricas_ia.cliente_vip = true → Atendimento mais personalizado
- metricas_ia.risco_churn = alto → Incentive o retorno com gentileza
- metricas_ia.sugerir_retorno = true → Use a sugestao_retorno_mensagem
- cliente.bloqueado = true → NÃO ofereça agendamentos nem horários. Responda gentilmente: "Infelizmente não consigo realizar agendamentos no momento. Entre em contato diretamente com a barbearia para mais informações. 😊" — NÃO explique o motivo, NÃO chame nenhuma tool.
</comportamento_inteligente>

<audio>
Mensagens de áudio são transcritas automaticamente antes de chegar até você — trate-as exatamente como texto normal.
NUNCA diga que não consegue entender áudio, que só funciona por texto ou qualquer variação disso.
</audio>

<proibicoes>
NUNCA faça:
- Inventar horários, preços, serviços ou profissionais
- Oferecer, sugerir ou aceitar data marcada como "⛔ FECHADO" no <calendario>
- Raciocinar em voz alta, fazer pergunta retórica a si mesmo ou se corrigir no meio da resposta — decida tudo ANTES de escrever e envie só a conclusão
- Mencionar ao cliente código de erro, nome de tool, nome de campo (servico_id, appointment_id), "retorno", "API", "sistema retornou" ou qualquer detalhe técnico — traduza sempre para linguagem de cliente
- Insistir na mesma operação depois de um retorno com success: false — leia o campo message, responda ao cliente e pare
- Dizer que "não há horários" quando a tool retornou erro técnico — nesse caso use a frase exata de <interpretacao_retorno_horarios>
- Usar horarios_funcionamento ou dados do contexto para afirmar disponibilidade de horário específico — disponibilidade real vem SOMENTE de consultar-horarios
- Confirmar ação sem success: true da tool
- Exibir UUIDs ou IDs internos ao cliente
- Usar nome de serviço digitado pelo cliente — sempre use o nome exato dos serviços disponíveis
- Usar nome de profissional digitado pelo cliente sem verificar antes na seção <profissionais_disponiveis> — se o profissional não existir na lista, informe o cliente imediatamente e apresente os nomes disponíveis
- Consultar horários ou agendar para um profissional que não está na seção <profissionais_disponiveis>
- Usar agendar-rapido quando o assinante está agendando para outra pessoa — nesses casos a tool correta é SEMPRE agendar-para-terceiro
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
Dados do cliente para preencher a tool:
- cliente_whatsapp → use cliente.whatsapp do contexto. NUNCA pergunte ao cliente.
- cliente_nome → use cliente.nome do contexto se disponível. Só pergunte se cliente_novo=true E nome estiver vazio. ⛔ NUNCA use um nome genérico/placeholder como "Cliente", "Cliente novo" ou similar pra preencher esse campo obrigatório — se não souber o nome real, PARE e pergunte antes de chamar a tool.

Fluxo obrigatório antes de chamar:
0. Se o cliente pediu um profissional específico, verifique IMEDIATAMENTE se o nome existe (mesmo que parcialmente) em <profissionais_disponiveis>. Se não existir → informe que não há esse profissional e liste os disponíveis. NÃO continue o fluxo.
1. Chame consultar-horarios para confirmar disponibilidade em tempo real — SEMPRE passe servico_nome (nome exato do serviço), senão a lista não considera a duração e o horário pode não caber
2. Confirme serviço + data + hora estão disponíveis no retorno da tool
3. Use o nome EXATO do serviço da seção servicos_disponiveis
4. Use o nome EXATO do profissional da seção profissionais_disponiveis
5. Se o horário não constar no retorno de consultar-horarios → informe e sugira os disponíveis
6. Exiba resumo: serviço, data, hora, profissional (se informado)
7. Aguarde confirmação explícita do cliente
8. Chame a tool agendar-rapido

Verificação pós-agendamento OBRIGATÓRIA:
9. Imediatamente após receber o retorno de agendar-rapido, chame consultar-agendamentos
10. Verifique se o agendamento novo aparece na lista com data e hora corretas
11. SE APARECER → confirme ao cliente com os dados reais do agendamento
12. SE NÃO APARECER → tente agendar-rapido novamente UMA vez
13. Se na segunda tentativa também não aparecer → informe: "Houve uma instabilidade no sistema. Pode tentar novamente em instantes? 😅"
NUNCA confirme ao cliente sem esta verificação.

Respostas: success:true → verifique com consultar-agendamentos antes de confirmar | SLOT_UNAVAILABLE → sugira alternativas | SERVICE_NOT_FOUND → mostre serviços disponíveis
</tool>

<tool name="editar-agendamento">
⛔ NENHUM assinante ativo (RECORRENTE ou FICHAS — veredito CASO 1 em <regras_assinantes>) PODE reagendar — NEM tente chamar esta tool nesse caso, explique educadamente direto. Se mesmo assim o retorno vier com type: SUBSCRIBER_RESCHEDULE_BLOCKED, use o campo message para responder ao cliente — NÃO insista, NÃO tente outro appointment_id.

Fluxo obrigatório (cliente NÃO assinante):
1. Chame consultar-agendamentos para obter o appointment_id
2. Mostre o agendamento ao cliente
3. Se mais de um → pergunte qual alterar
4. Confirme o que será alterado
5. Chame consultar-horarios para verificar disponibilidade em tempo real da nova data/hora — passe servico_nome com o serviço do agendamento (veio em consultar-agendamentos) e profissional_nome, para a lista já considerar a duração
6. Se o horário não constar → informe e sugira os disponíveis
7. Envie APENAS os campos que mudam
8. Chame a tool editar-agendamento
BLOQUEIO: Sem appointment_id válido via consultar-agendamentos → NÃO chame esta tool.

Verificação pós-reagendamento OBRIGATÓRIA:
9. Imediatamente após receber o retorno de editar-agendamento, chame consultar-agendamentos novamente
10. Verifique se o agendamento aparece com a nova data/hora
11. SE APARECER com os dados corretos → confirme ao cliente com os dados reais
12. SE NÃO APARECER ou a data/hora não tiver mudado → tente editar-agendamento novamente UMA vez
13. Se na segunda tentativa também não aparecer → informe: "Houve uma instabilidade ao reagendar. Pode tentar novamente em instantes? 😅"
NUNCA confirme reagendamento ao cliente sem esta verificação.
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
2. Se contiver error → para consultar-horarios siga <interpretacao_retorno_horarios>; para as demais tools informe que houve instabilidade e peça para tentar em instantes — NUNCA invente dados
2a. Se vier type: MISSING_CLIENT_NAME (agendar-rapido/agendar-para-terceiro) → NÃO é instabilidade. Pergunte o nome real do cliente e só chame a tool de novo depois que ele responder.
2b. Se vier success: false com type: SLOT_UNAVAILABLE ou TIME_CONFLICT (agendar-rapido/agendar-para-terceiro/editar-agendamento) → o horário não comporta o serviço. NÃO é instabilidade e NÃO tente de novo com o mesmo horário. Diga ao cliente que esse horário não está disponível e ofereça SOMENTE os horários do campo horarios_disponiveis desse retorno (ou, se vier vazio, outro dia). Uma frase, sem explicar o motivo técnico.
2c. Se vier type: TECH_ERROR → responda exatamente o texto indicado no campo message e encerre. NÃO tente de novo, NÃO explique.
3. NUNCA confirme uma ação sem verificar o retorno

Para agendar-rapido, agendar-para-terceiro e editar-agendamento especificamente:
4. Mesmo com success: true, chame consultar-agendamentos IMEDIATAMENTE para confirmar que o agendamento existe no sistema
5. Só confirme ao cliente após essa verificação
6. Se o agendamento não aparecer, repita a operação uma vez antes de informar erro ao cliente
</validacao_pos_chamada>
</tools>

<fluxos_atendimento>
<fluxo_rapido>
Cliente já informou serviço + data + hora:
1. Localize o nome exato em servicos_disponiveis
2. Chame consultar-horarios para a data informada (OBRIGATÓRIO — nunca pule esta etapa)
3. Verifique se o horário pedido consta na resposta da tool como disponível
4. Se não constar → informe que o horário não está disponível e apresente os horários retornados pela tool
5. Se constar → mostre resumo: serviço, data, hora, profissional
6. Peça confirmação
7. Cliente confirma → chame agendar-rapido
</fluxo_rapido>

<fluxo_parcial>
Faltam informações:
- Pergunte TUDO que falta em UMA única mensagem
- "tem horário amanhã?" → SEMPRE chame consultar-horarios para obter disponibilidade em tempo real; NUNCA use apenas os dados de profissionais_disponiveis
- "quero agendar" sem dados → pergunte serviço, data e hora juntos; ao receber a data, chame consultar-horarios antes de mostrar opções
</fluxo_parcial>

<interpretacao_datas>
- cliente NÃO mencionou data → use HOJE automaticamente (ver <datetime>). Só use outra data se o cliente disser EXPLICITAMENTE: "amanhã", "sexta", "dia 15" etc. ❌ PROIBIDO perguntar "Para qual data?", "Qual dia você prefere?"
- hoje → data atual (ver <datetime>)
- amanhã → linha marcada "← AMANHÃ" no <calendario>
- a palavra "amanhã" refere-se EXCLUSIVAMENTE à data da linha "← AMANHÃ". Ao anunciar quando a barbearia reabre, copie a SITUAÇÃO DE HOJE do <datetime> — se o próximo dia aberto não for a linha ← AMANHÃ, cite-o pelo dia da semana ("na terça"), NUNCA como "amanhã"
- dias da semana ("quinta", "próxima terça", "sábado") → localize o dia no <calendario> e use o YYYY-MM-DD correspondente. NUNCA calcule de cabeça.
- ANTES de oferecer ou aceitar qualquer data, verifique a linha dela no <calendario>: se estiver "⛔ FECHADO", NÃO prossiga — informe os dias abertos e sugira o mais próximo.
- ao confirmar uma data ao cliente, cite o dia da semana EXATAMENTE como está no <calendario> para a data — nunca deduza.
- "2h da tarde" → "14:00" | "meio-dia" → "12:00" | sempre HH:MM
</interpretacao_datas>

<interpretacao_retorno_horarios>
Interprete o retorno de consultar-horarios EXATAMENTE assim:
- retorno contém campo "error" → erro técnico; NÃO invente horários; NÃO diga que não há horários; NÃO use horarios_funcionamento como substituto. Responda SOMENTE: "Não consegui verificar os horários agora 😅 Pode tentar em instantes?" e encerre.
- success=false com type=CLOSED_DAY → a barbearia NÃO abre nesse dia; NUNCA trate como "sem vagas". Informe os dias de funcionamento (campo dias_abertos) e sugira outra data.
- success=false com type=SUBSCRIBER_RESCHEDULE_BLOCKED → assinante ativo (recorrente ou fichas) tentando reagendar o próprio atendimento; use o campo message para responder. NÃO ofereça horários alternativos, NÃO tente consultar-horarios de novo — encerre esse assunto educadamente.
- success=true mas horarios_disponiveis vazio → dia aberto porém sem vagas (lotado ou folga do profissional). Informe e ofereça outro dia ou outro profissional.
- success=true com horários → prossiga normalmente oferecendo APENAS os horários retornados.
</interpretacao_retorno_horarios>
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
- Tolerância de atraso: 5 minutos
- Falta = serviço descontado, sem reagendamento
</planos_assinaturas>

<politica_atrasos_faltas>
Compartilhe APENAS quando o cliente perguntar sobre atraso ou enviar mensagem avisando que vai se atrasar. Nunca mencione proativamente.

Mensagem a enviar (adapte ao contexto, mantenha o tom):
"Entendemos que imprevistos acontecem 😊 Nossa tolerância de atraso é de 5 minutos — depois disso infelizmente não temos tempo hábil sem atrasar o próximo cliente.

Se você for assinante, a gente tenta remarcar, mas a agenda costuma estar bem apertada.
Se for avulso e já teve uma desmarcação antes, haverá um acréscimo de 10% no próximo atendimento.

Tudo isso pra garantir que nosso barbeiro não fique parado esperando. Obrigado por entender! 🙏"
</politica_atrasos_faltas>

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
  clienteWhatsapp: string,
  context: Record<string, unknown>,
  userInfo: Record<string, unknown>
): Promise<unknown> {
  const base = { action: toolName, user_id: userId };

  switch (toolName) {
    case "listar-servicos":
    case "listar-profissionais":
      return callFunction("ai-agent-appointments", base);

    case "consultar-horarios": {
      // Se o assinante ativo já consultou os próprios agendamentos nesta
      // conversa, essa consulta de horários é quase sempre pra reagendar o
      // PRÓPRIO atendimento — bloqueia antes de oferecer horários que depois
      // não poderão ser confirmados (editar-agendamento também bloqueia).
      if ((context as Record<string, unknown>)._consultouAgendamentoProprio) {
        const blocked = assinanteRescheduleGuard(context);
        if (blocked) return blocked;
      }
      const closed = closedDayGuard(input.data_consulta, userInfo);
      if (closed) return closed;
      const servicoId = resolveServicoId(context, input.servico_id, input.servico_nome);
      try {
        return await callFunction("ai-agent-appointments", {
          ...base,
          data: {
            data_consulta: input.data_consulta,
            profissional_id: input.profissional_id,
            profissional_nome: input.profissional_nome,
            ...(servicoId ? { servico_id: servicoId } : {}),
          },
        });
      } catch (err) {
        const ax = err as { response?: { status?: number; data?: unknown }; message?: string };
        console.error(
          `[consultar-horarios] FALHA status=${ax.response?.status ?? "?"} ` +
          `body=${JSON.stringify(ax.response?.data ?? ax.message ?? err)} ` +
          `input=${JSON.stringify({ data_consulta: input.data_consulta, profissional_id: input.profissional_id, profissional_nome: input.profissional_nome })}`
        );
        // Antes de retornar erro genérico, tenta deduzir disponibilidade pelo contexto
        const fallback = contextFallbackHorarios(
          context,
          input.profissional_id as string | undefined,
          input.profissional_nome as string | undefined,
          input.data_consulta as string
        );
        if (fallback !== null) return fallback;
        return { error: "Falha ao consultar horários. Não use dados do contexto como substituto." };
      }
    }

    case "consultar-agendamentos": {
      // Marca que o assinante (plano recorrente) consultou os próprios
      // agendamentos nesta conversa — usado por consultar-horarios pra
      // detectar reagendamento. Assinante por fichas fica de fora: pra ele
      // isso é uma consulta normal antes de um agendamento comum.
      if (isAssinanteRecorrente(context)) {
        (context as Record<string, unknown>)._consultouAgendamentoProprio = true;
      }
      return callFunction("ai-agent-appointments", {
        ...base,
        data: { cliente_whatsapp: clienteWhatsapp, ...input },
      });
    }

    case "agendar-rapido": {
      const nomeBlocked = nomeGenericoGuard(input.cliente_nome);
      if (nomeBlocked) return nomeBlocked;
      const closed = closedDayGuard(input.data, userInfo);
      if (closed) return closed;
      const result = await callFunction("ai-agent-appointments", { ...base, data: input }) as Record<string, unknown>;
      return {
        ...result,
        _solicitado_profissional: input.profissional_nome ?? null,
        _solicitado_servico: input.servico_nome,
        _solicitado_data: input.data,
        _solicitado_hora: input.hora,
      };
    }

    case "agendar-para-terceiro": {
      const nomeBlocked = nomeGenericoGuard(input.cliente_nome);
      if (nomeBlocked) return nomeBlocked;
      const closed = closedDayGuard(input.data, userInfo);
      if (closed) return closed;
      const result = await callFunction("ai-agent-appointments", { ...base, action: "criar-agendamento", data: input }) as Record<string, unknown>;
      return {
        ...result,
        _solicitado_profissional: input.profissional_nome ?? null,
        _solicitado_servico: input.servico_nome,
        _solicitado_data: input.data,
        _solicitado_hora: input.hora,
      };
    }

    case "editar-agendamento": {
      const blocked = assinanteRescheduleGuard(context);
      if (blocked) return blocked;
      const { appointment_id, ...rest } = input;
      const closed = closedDayGuard(rest.data, userInfo);
      if (closed) return closed;
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
  aiModel?: string;
  apiKey?: string;
  deepseekApiKey?: string;
}): Promise<{ text: string; newMessages: Anthropic.MessageParam[] }> {
  const { messages, history, userId, clienteWhatsapp, context, userInfo, aiModel = "claude-haiku-4-5-20251001", apiKey, deepseekApiKey } = params;

  // Cliente bloqueado: retorna imediatamente sem chamar a API
  const clienteCtx = (context.cliente || {}) as Record<string, unknown>;
  if (clienteCtx.bloqueado === true) {
    return {
      text: "Olá! Infelizmente não consigo realizar agendamentos no momento. Entre em contato diretamente com a barbearia para mais informações. 😊",
      newMessages: [],
    };
  }

  const tag = `[agent][${clienteWhatsapp.slice(-4)}]`;
  const userText = messages.join("\n");
  const systemPrompt = buildSystemPrompt(context, userInfo);

  const conversationMessages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userText },
  ];

  let response = await callLLM({
    model: aiModel,
    max_tokens: 1024,
    temperature: 0.3,
    system: systemPrompt,
    tools: TOOLS,
    messages: conversationMessages,
    anthropicApiKey: apiKey,
    deepseekApiKey,
  });

  // Agentic loop
  let rounds = 0;
  while (response.stop_reason === "tool_use") {
    if (++rounds > MAX_TOOL_ROUNDS) {
      console.error(`${tag} loop de tools excedeu ${MAX_TOOL_ROUNDS} rodadas — abortando turno`);
      return { text: LEAK_FALLBACK, newMessages: [] };
    }
    const assistantMsg: Anthropic.MessageParam = {
      role: "assistant",
      content: response.content,
    };

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const inputPreview = JSON.stringify(block.input).slice(0, 200);
      console.log(`${tag} tool → ${block.name}(${inputPreview})`);

      let result: unknown;
      try {
        result = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          userId,
          clienteWhatsapp,
          context,
          userInfo
        );
        console.log(`${tag} tool ← ${block.name}: ${JSON.stringify(result).slice(0, 200)}`);
      } catch (err: unknown) {
        // Detalhe técnico (status, mensagem do axios) fica SÓ no log. O modelo
        // recebe uma instrução pronta do que dizer — se ele vê "409" ou
        // "Request failed", tende a repetir isso pro cliente.
        const msg = err instanceof Error ? err.message : String(err);
        const ax = err as { response?: { status?: number; data?: unknown } };
        console.error(
          `[tool:${block.name}] erro: ${msg} status=${ax.response?.status ?? "?"} body=${JSON.stringify(ax.response?.data ?? null).slice(0, 300)}`
        );
        result = {
          success: false,
          type: "TECH_ERROR",
          error: "Instabilidade técnica ao executar a operação.",
          message:
            "Houve uma instabilidade no sistema. NÃO tente de novo nem explique o problema técnico ao cliente. Responda apenas: \"Tive uma instabilidade aqui 😅 Pode tentar de novo em instantes?\" e encerre.",
        };
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    conversationMessages.push(assistantMsg);
    conversationMessages.push({ role: "user", content: toolResults });

    response = await callLLM({
      model: aiModel,
      max_tokens: 1024,
      temperature: 0.3,
      system: systemPrompt,
      tools: TOOLS,
      messages: conversationMessages,
      anthropicApiKey: apiKey,
      deepseekApiKey,
    });
  }

  // Adiciona a resposta final do assistente ao histórico completo
  conversationMessages.push({ role: "assistant", content: response.content });

  const textBlock = response.content.find((b) => b.type === "text");
  const rawText = textBlock ? (textBlock as Anthropic.TextBlock).text : "";

  const { text, leaked } = sanitizeReply(rawText);
  if (leaked) {
    console.error(`${tag} resposta vazou raciocínio/termo técnico — substituída. Original: ${rawText.slice(0, 500)}`);
    // Não guarda a resposta vazada no histórico, senão o modelo continua o
    // "raciocínio" no próximo turno a partir dela.
    conversationMessages[conversationMessages.length - 1] = {
      role: "assistant",
      content: [{ type: "text", text }],
    };
  }

  // Retorna o texto e todas as mensagens do turno atual (sem o histórico anterior)
  const newMessages = conversationMessages.slice(history.length);

  return { text, newMessages };
}
