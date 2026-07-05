// Teste manual das blindagens de dia fechado (rodar: node test-blindagem.js)
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";

const { closedDayGuard, contextFallbackHorarios, buildSystemPrompt } = require("./dist/agent.js");

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures++;
}

const userInfo = {
  nome_agente: "Bia",
  horarios_por_dia: {
    domingo: { fechado: true },
    segunda: { fechado: true },
    terca: { abertura: "09:00", fechamento: "19:00" },
    quarta: { abertura: "09:00", fechamento: "19:00" },
    quinta: { abertura: "09:00", fechamento: "19:00" },
    sexta: { abertura: "09:00", fechamento: "19:00" },
    sabado: { abertura: "09:00", fechamento: "18:00" },
  },
};

// 2026-07-05 é domingo; 2026-07-07 é terça
const closed = closedDayGuard("2026-07-05", userInfo);
check("domingo → CLOSED_DAY local", closed && closed.type === "CLOSED_DAY" && closed.success === false);
check("CLOSED_DAY cita dia_semana=domingo", closed && closed.dia_semana === "domingo");
check("CLOSED_DAY lista dias abertos sem segunda/domingo", closed && closed.dias_abertos === "terça, quarta, quinta, sexta, sábado");

check("segunda (também fechada) → CLOSED_DAY", (closedDayGuard("2026-07-06", userInfo) || {}).type === "CLOSED_DAY");
check("terça (aberta) → null (segue para a edge)", closedDayGuard("2026-07-07", userInfo) === null);
check("data inválida → null", closedDayGuard("amanhã", userInfo) === null);
check("sem horarios_por_dia → null (edge valida)", closedDayGuard("2026-07-05", {}) === null);

// Calendário anotado no prompt
const prompt = buildSystemPrompt({ barbearia: {}, cliente: {} }, userInfo);
const linhas = prompt.split("\n").filter((l) => /^\s+\d{4}-\d{2}-\d{2} = /.test(l));
check("calendário tem 14 linhas", linhas.length === 14);
const domingos = linhas.filter((l) => l.includes("domingo"));
check("todo domingo do calendário marcado ⛔ FECHADO", domingos.length > 0 && domingos.every((l) => l.includes("⛔ FECHADO")));
const tercas = linhas.filter((l) => l.includes("terça"));
check("toda terça marcada (aberto 09:00–19:00)", tercas.length > 0 && tercas.every((l) => l.includes("(aberto 09:00–19:00)")));
const sabados = linhas.filter((l) => l.includes("sábado"));
check("sábado com horário próprio 09:00–18:00", sabados.length > 0 && sabados.every((l) => l.includes("(aberto 09:00–18:00)")));

// Fallback de contexto
const context = {
  barbearia: {
    profissionais_disponiveis: [
      {
        id: "p1",
        nome: "Wendell",
        especialidade: "Cortes",
        disponibilidade: [
          { data: "2026-07-07", dia_semana: "terça", horarios_disponiveis: ["09:00", "10:00"] },
        ],
      },
    ],
  },
};
const fb = contextFallbackHorarios(context, undefined, "wendell", "2026-07-07");
check("fallback acha slots do Wendell na terça", fb && fb.success === true && fb.horarios_disponiveis.length === 2);
const fbFolga = contextFallbackHorarios(context, undefined, "wendell", "2026-07-08");
check("fallback: data ausente = 0 slots (folga)", fbFolga && fbFolga.success === true && fbFolga.horarios_disponiveis.length === 0);
check("fallback: contexto vazio → null", contextFallbackHorarios({ barbearia: {} }, undefined, "wendell", "2026-07-07") === null);

process.exit(failures === 0 ? 0 : 1);
