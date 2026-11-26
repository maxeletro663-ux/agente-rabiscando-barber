// Pagamento prévio por período (26/11/2026 — Rabiscando, fim de ano).
//
// Num período configurado pelo dono (profiles.pagamento_previo_*), o
// agendamento feito pelo cliente só é concluído depois que a barbearia confirma
// o pagamento. A regra mora no banco: o gatilho marca o agendamento como
// "aguardando pagamento" (agendamentos.aguardando_pagamento_ate), a função de
// notificação não manda a confirmação ao cliente e um cron cancela quem passa
// do prazo. Aqui o agente só precisa: (1) saber do período para avisar o
// cliente, (2) trocar o "agendamento confirmado" pelo aviso + PIX + pedido do
// comprovante quando o agendamento criado ficou aguardando.

import axios from "axios";

const BASE = process.env.SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;
const headers = { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json" };

export interface PagamentoPrevioConfig {
  inicio: string; // yyyy-MM-dd
  fim: string | null;
  mensagem: string | null;
  pix: string | null;
  whatsapp: string | null;
  minutos: number;
}

const MENSAGEM_PADRAO =
  "Os agendamentos deste período só são concluídos após a confirmação do pagamento. Envie o comprovante para que possamos confirmar o seu agendamento!";

/** Configuração ativa do dono, ou null (recurso desligado, vencido ou erro). */
export async function getPagamentoPrevio(userId: string): Promise<PagamentoPrevioConfig | null> {
  try {
    const res = await axios.post(`${BASE}/rest/v1/rpc/pagamento_previo_config`, { _user_id: userId }, { headers, timeout: 10_000 });
    const cfg = res.data as PagamentoPrevioConfig | null;
    return cfg && cfg.inicio ? cfg : null;
  } catch {
    return null;
  }
}

export function dataNoPeriodo(cfg: PagamentoPrevioConfig | null | undefined, isoDate: unknown): boolean {
  if (!cfg || typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return false;
  const d = isoDate.slice(0, 10);
  if (d < cfg.inicio) return false;
  if (cfg.fim && d > cfg.fim) return false;
  return true;
}

const br = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };

function textoAviso(cfg: PagamentoPrevioConfig): string {
  return (cfg.mensagem || "").trim() || MENSAGEM_PADRAO;
}

/** Bloco do prompt: o agente fica sabendo do período ANTES de agendar. */
export function promptPagamentoPrevio(cfg: PagamentoPrevioConfig | null | undefined): string {
  if (!cfg) return "";
  const periodo = cfg.fim ? `de ${br(cfg.inicio)} a ${br(cfg.fim)}` : `a partir de ${br(cfg.inicio)}`;
  return `<pagamento_antecipado_periodo>
⚠️ REGRA DO PERÍODO — vale para agendamentos com DATA ${periodo} (cliente que NÃO é assinante):
- Aviso oficial da barbearia: "${textoAviso(cfg)}"
- Você agenda normalmente com as tools, MAS nessas datas o agendamento NÃO fica confirmado na hora: ele fica RESERVADO por ${cfg.minutos} minutos aguardando o pagamento.
- Quando a tool de agendamento devolver aguardando_pagamento=true: NUNCA diga "agendado", "confirmado" ou "garantido". Diga que o horário está RESERVADO, informe o aviso acima, mande a chave PIX exatamente como veio no retorno (sozinha numa linha, para copiar) e peça o comprovante aqui nesta conversa. Informe o horário-limite que veio no retorno.
- Esta regra vale MAIS que qualquer instrução de "confirmar ao cliente" depois de agendar: a verificação com consultar-agendamentos continua sendo feita, mas a resposta final é sempre a de RESERVA aguardando pagamento, nunca a de agendamento confirmado.
- Se o cliente perguntar sobre uma data do período antes de agendar, avise logo que nessas datas o agendamento só é concluído com o pagamento antecipado por PIX.
- Comprovante: você NÃO consegue ver imagens nem validar pagamento. Se o cliente mandar imagem/arquivo ou disser que pagou, responda que recebeu e que a confirmação chega aqui no WhatsApp assim que a barbearia conferir. NUNCA diga que o pagamento foi confirmado.
- Quem confirma é a barbearia. Se passar do prazo sem confirmação, a reserva é liberada sozinha; se o cliente voltar depois, explique e ofereça reservar de novo (consultando os horários outra vez).
- TROCAR HORÁRIO ou NOVO AGENDAMENTO quando o cliente JÁ TEM agendamento numa data do período: antes de qualquer tool, diga: "Para um novo agendamento é necessário um novo pagamento, porque o horário foi reservado. Deseja fazer um novo agendamento?" Só siga se ele confirmar — e aí é sempre um agendamento NOVO (fica reservado aguardando o novo pagamento). Não use editar-agendamento para datas do período.
- CANCELAR agendamento de uma data do período: antes de chamar cancelar-agendamento, avise: "Ao cancelar o agendamento, para fazer um novo será necessário efetuar um novo pagamento!" e só cancele depois que o cliente confirmar que quer cancelar mesmo assim.
- Assinante usando o plano não entra nessa regra.
</pagamento_antecipado_periodo>`;
}

/**
 * Depois de criar um agendamento: se ele ficou aguardando pagamento, acrescenta
 * ao retorno da tool o que o modelo precisa dizer (e o que não pode dizer).
 */
export async function aplicarPagamentoPrevio(
  result: Record<string, unknown>,
  cfg: PagamentoPrevioConfig | null | undefined,
  dataSolicitada: unknown
): Promise<Record<string, unknown>> {
  if (!cfg || result?.success !== true || !dataNoPeriodo(cfg, dataSolicitada)) return result;
  const agendamento = result.agendamento as { id?: string; aguardando_pagamento_ate?: string | null } | undefined;
  if (!agendamento?.id) return result;

  let ate: string | null = agendamento.aguardando_pagamento_ate ?? null;
  try {
    const res = await axios.post(`${BASE}/rest/v1/rpc/pagamento_previo_status`, { _ids: [agendamento.id] }, { headers, timeout: 10_000 });
    const linha = (res.data as { aguardando_pagamento_ate?: string | null }[] | null)?.[0];
    if (linha) ate = linha.aguardando_pagamento_ate ?? null;
  } catch {
    // Sem resposta: fica com o que veio no próprio agendamento
  }
  if (!ate) return result;

  const limite = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date(ate));
  return {
    ...result,
    message: "RESERVA criada — AGUARDANDO PAGAMENTO. O agendamento NÃO está confirmado.",
    aguardando_pagamento: true,
    pagamento: {
      aviso: textoAviso(cfg),
      chave_pix: cfg.pix || null,
      prazo_minutos: cfg.minutos,
      reservado_ate: limite,
      instrucao:
        `NÃO diga que está agendado/confirmado. Diga que o horário ficou RESERVADO até ${limite}, repita o aviso, ` +
        (cfg.pix ? `envie a chave PIX "${cfg.pix}" sozinha numa linha` : `diga que a barbearia vai informar a chave PIX`) +
        ` e peça para o cliente mandar o comprovante aqui nesta conversa. A confirmação chega depois que a barbearia conferir o pagamento.`,
    },
  };
}

/**
 * Remarcar PARA uma data do período pelo agente não passa pelo fluxo de
 * pagamento (é uma alteração, não uma criação) — bloqueia e orienta.
 */
export function editarParaPeriodoGuard(
  cfg: PagamentoPrevioConfig | null | undefined,
  novaData: unknown
): Record<string, unknown> | null {
  if (!dataNoPeriodo(cfg, novaData)) return null;
  return {
    success: false,
    type: "PAYMENT_PERIOD_RESCHEDULE_BLOCKED",
    message:
      "Remarcação para uma data do período de pagamento antecipado não é feita por aqui. " +
      'Diga ao cliente: "Para um novo agendamento é necessário um novo pagamento, porque o horário foi reservado. Deseja fazer um novo agendamento?" ' +
      "Se ele confirmar, crie um agendamento NOVO (ele fica reservado até o novo pagamento ser confirmado). " +
      "O agendamento antigo continua valendo até o cliente pedir para cancelar.",
  };
}
