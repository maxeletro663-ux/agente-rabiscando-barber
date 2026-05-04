import Fastify from "fastify";
import { processMessage } from "./processor";

const app = Fastify({ logger: true });

app.post("/webhook", async (request, reply) => {
  const body = request.body as Record<string, unknown>;

  // Validate basic structure
  if (!body?.event || !body?.instance || !body?.data) {
    return reply.code(400).send({ error: "Invalid payload" });
  }

  // Only handle message events
  if (body.event !== "messages.upsert") {
    return reply.code(200).send({ ok: true });
  }

  const data = body.data as Record<string, unknown>;
  const key = data.key as Record<string, unknown>;
  const message = data.message as Record<string, unknown> | undefined;

  const jid = String(key?.remoteJid || "");
  const fromMe = Boolean(key?.fromMe);
  const messageType = String(data.messageType || "");
  const pushName = String(data.pushName || "");
  const messageId = String(key?.id || "");

  const text =
    (message?.conversation as string | undefined) ||
    (message?.extendedTextMessage as { text?: string } | undefined)?.text ||
    (message?.speechToText as string | undefined) ||
    "";

  const hasAudio = Boolean(message?.audioMessage);

  // Process async — return 200 immediately so Evolution doesn't retry
  setImmediate(() => {
    processMessage({
      instance: String(body.instance),
      jid,
      fromMe,
      messageType,
      text,
      messageId,
      pushName,
      audioBase64: undefined,
    }).catch((err) => {
      console.error(`[${body.instance}] Erro ao processar mensagem:`, err);
    });
  });

  return reply.code(200).send({ ok: true });
});

app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

const PORT = parseInt(process.env.PORT || "3000", 10);

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🤖 WhatsApp Agent rodando na porta ${PORT}`);
});
