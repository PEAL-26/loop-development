import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import type { Plugin } from "@opencode-ai/plugin";
import * as core from "./core/telegram-core.js";

// Plugin: aprovações de permissões e respostas a perguntas via Telegram.
// - Long-polling getUpdates (funciona atrás de NAT, sem portas públicas).
// - Apenas chats autorizados (emparelhamento com /start <chave>).
// - Limite de 1 instância a fazer polling (409 encerra o polling).
// - Usa as rotas HTTP atuais do servidor:
//     POST /permission/:requestID/reply  body { reply: "once"|"always"|"reject", message? }
//     POST /question/:requestID/reply    body { answers: string[][] }
//     POST /question/:requestID/reject
//     GET  /permission   GET /question   (listas de pendentes)

const TELEGRAM_API = "https://api.telegram.org";

function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode");
  return join(homedir(), ".config", "opencode");
}

const STATE_FILE = join(configDir(), "telegram-state.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let token = "";
let state: { token?: string; pairingKey: string | null; allowedChatIds: number[] } = {
  pairingKey: null,
  allowedChatIds: [],
};
let client: any = null;
let directory = "";
let stopPolling = false;
let warnedChats = new Set<number>();
let sentRequests = new Set<string>();
let pendingPermissions = new Map<string, any>();
let pendingQuestions = new Map<string, any>();
let messageToQuestion = new Map<string, { requestID: string; qIndex: number }>();
let messageToPermission = new Map<string, { requestID: string }>();

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    state = { ...state, ...JSON.parse(raw) };
  } catch {
    // sem estado ainda
  }
  token = process.env.OPENCODE_TELEGRAM_BOT_TOKEN || state.token || "";
}

async function saveState() {
  try {
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error("[telegram] save state:", err);
  }
}

function authorized(chatId: number) {
  return core.isAuthorized(chatId, state.allowedChatIds);
}

// Chamada à API do servidor com o client da SDK. Fallbacks para maximizar
// compatibilidade com as diferentes versões do client exposto aos plugins.
async function api(opts: { method: "GET" | "POST"; url: string; query?: Record<string, unknown>; body?: unknown }) {
  const c = client as any;
  const request = c?.request ?? c?._client?.request;
  if (typeof request !== "function") throw new Error("client sem método request");
  const res = await request.call(c, {
    method: opts.method,
    url: opts.url,
    query: { directory, ...(opts.query ?? {}) },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  if (res?.error != null) throw new Error(typeof res.error === "string" ? res.error : "pedido rejeitado pelo servidor");
  return res?.data;
}

async function tg(method: string, body: any) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(chatId: number, text: string, replyMarkup: any) {
  const body: any = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const data = await tg("sendMessage", body);
  return data.ok ? data.result : null;
}

async function editMessageText(chatId: number, messageId: number, text: string, replyMarkup: any) {
  const body: any = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup === null) body.reply_markup = { inline_keyboard: [] };
  else if (replyMarkup) body.reply_markup = replyMarkup;
  await tg("editMessageText", body);
}

async function editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: any) {
  await tg("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  });
}

async function answerCallback(callbackQueryId: string, text: string) {
  await tg("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

function projectName() {
  return core.baseName(directory);
}

// ---------------------------------------------------------------------------
// Notificações de pedidos
// ---------------------------------------------------------------------------

async function notifyPermission(req: any, stale: boolean) {
  if (!token || state.allowedChatIds.length === 0) return;
  pendingPermissions.set(req.id, req);
  const text =
    core.permissionText(req, projectName()) + (stale ? "\n\n⏳ (pendente antes do restart)" : "");
  for (const chatId of state.allowedChatIds) {
    const sent = await sendMessage(chatId, text, core.permissionKeyboard(req.id));
    if (sent?.message_id) {
      messageToPermission.set(`${chatId}:${sent.message_id}`, { requestID: req.id });
    }
  }
}

async function notifyQuestion(req: any, stale: boolean) {
  if (!token || state.allowedChatIds.length === 0) return;
  const track = {
    request: req,
    answers: req.questions.map(() => null),
    selections: req.questions.map(() => [] as number[]),
    messages: req.questions.map(() => null),
  };
  pendingQuestions.set(req.id, track);
  for (let i = 0; i < req.questions.length; i++) {
    const q = req.questions[i];
    const text =
      core.questionText(q, projectName(), i, req.questions.length) +
      (stale ? "\n\n⏳ (pendente antes do restart)" : "");
    const kb = core.questionKeyboard(req.id, i, q, []);
    for (const chatId of state.allowedChatIds) {
      const sent = await sendMessage(chatId, text, kb);
      if (sent?.message_id) {
        track.messages[i] = { chatId, messageId: sent.message_id };
        messageToQuestion.set(`${chatId}:${sent.message_id}`, { requestID: req.id, qIndex: i });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Perguntas: completar quando todas respondidas
// ---------------------------------------------------------------------------

async function completeQuestion(requestID: string, track: any) {
  if (track.answers.some((a: any) => a == null)) return;
  try {
    await api({
      method: "POST",
      url: `/question/${requestID}/reply`,
      body: { answers: track.answers },
    });
    for (let i = 0; i < track.messages.length; i++) {
      const m = track.messages[i];
      if (m) {
        const ans = (track.answers[i] ?? []).join(", ") || "(em branco)";
        await editMessageText(m.chatId, m.messageId, `✅ Respondido: ${ans}`, null);
      }
    }
  } catch (err) {
    for (const m of track.messages) {
      if (m) await editMessageText(m.chatId, m.messageId, "⚠️ Já respondido (noutra janela)", null);
    }
  } finally {
    pendingQuestions.delete(requestID);
  }
}

// ---------------------------------------------------------------------------
// Mensagens do Telegram
// ---------------------------------------------------------------------------

async function handleMessage(msg: any) {
  const chatId = msg?.chat?.id;
  if (chatId == null || typeof msg.text !== "string") return;
  const text = msg.text.trim();

  if (text.startsWith("/start")) {
    const key = text.split(/\s+/)[1] ?? "";
    if (state.pairingKey && key === state.pairingKey) {
      if (!authorized(chatId)) {
        state.allowedChatIds = [...state.allowedChatIds, chatId];
        await saveState();
      }
      await sendMessage(
        chatId,
        "✅ Emparelhado! A partir de agora recebes aqui os pedidos de permissão e as perguntas.",
        null,
      );
    } else {
      await sendMessage(
        chatId,
        "Chave inválida. Gera uma com: loop-development telegram setup",
        null,
      );
    }
    return;
  }

  if (!authorized(chatId)) {
    if (!warnedChats.has(chatId)) {
      warnedChats.add(chatId);
      await sendMessage(chatId, "Não autorizado.", null);
    }
    return;
  }

  const replyTo = msg.reply_to_message?.message_id;
  if (replyTo != null) {
    const hit = messageToQuestion.get(`${chatId}:${replyTo}`);
    if (hit) {
      const track = pendingQuestions.get(hit.requestID);
      const q = track?.request.questions[hit.qIndex];
      if (!track || !q) return;
      if (q.custom === false) {
        await sendMessage(chatId, "Esta pergunta não aceita texto livre. Usa os botões.", null);
        return;
      }
      track.answers[hit.qIndex] = [text];
      await completeQuestion(hit.requestID, track);
    }
  }
}

async function handleCallback(cb: any) {
  const msg = cb?.message;
  const chatId = msg?.chat?.id;
  if (chatId == null || !authorized(chatId)) {
    if (cb?.id) await answerCallback(cb.id, "Não autorizado");
    return;
  }
  const data = core.parseCallbackData(cb?.data);
  if (!data) {
    await answerCallback(cb.id, "Ação desconhecida");
    return;
  }

  if (data.kind === "permission") {
    const { action, requestID } = data as any;
    if (action === "always") {
      const req = pendingPermissions.get(requestID);
      if (req) {
        await editMessageText(
          chatId,
          msg.message_id,
          core.permissionAlwaysConfirmText(req, projectName()),
          core.permissionAlwaysConfirmKeyboard(requestID),
        );
        await answerCallback(cb.id, "Confirma os padrões");
      } else {
        await answerCallback(cb.id, "Pedido já resolvido");
      }
      return;
    }
    const reply = action === "reject" ? "reject" : "once";
    try {
      await replyPermission(requestID, reply, chatId, msg.message_id, cb.id);
    } catch {
      await editMessageText(chatId, msg.message_id, "⚠️ Já respondido (noutra janela)", null);
      await answerCallback(cb.id, "Já respondido");
    }
    messageToPermission.delete(`${chatId}:${msg.message_id}`);
    return;
  }

  if (data.kind === "permission-confirm") {
    const { requestID, confirmed } = data as any;
    if (confirmed) {
      try {
        await replyPermission(requestID, "always", chatId, msg.message_id, cb.id);
      } catch {
        await editMessageText(chatId, msg.message_id, "⚠️ Já respondido (noutra janela)", null);
        await answerCallback(cb.id, "Já respondido");
      }
    } else {
      const req = pendingPermissions.get(requestID);
      if (req) {
        await editMessageText(
          chatId,
          msg.message_id,
          core.permissionText(req, projectName()),
          core.permissionKeyboard(requestID),
        );
        await answerCallback(cb.id, "Cancelado");
      }
    }
    messageToPermission.delete(`${chatId}:${msg.message_id}`);
    return;
  }

  if (data.kind === "question-option") {
    const track = pendingQuestions.get(data.requestID);
    if (!track) {
      await answerCallback(cb.id, "Pergunta já resolvida");
      return;
    }
    const q = track.request.questions[data.qIndex];
    const label = q?.options?.[data.optionIndex]?.label;
    if (label == null) {
      await answerCallback(cb.id, "Opção inválida");
      return;
    }
    if (data.mode === "multi") {
      const sel = track.selections[data.qIndex];
      const i = sel.indexOf(data.optionIndex);
      if (i >= 0) sel.splice(i, 1);
      else sel.push(data.optionIndex);
      await editMessageReplyMarkup(
        chatId,
        msg.message_id,
        core.questionKeyboard(data.requestID, data.qIndex, q, sel),
      );
      await answerCallback(cb.id, "Seleção atualizada");
    } else {
      track.answers[data.qIndex] = [label];
      await answerCallback(cb.id, "Ok");
      await completeQuestion(data.requestID, track);
    }
    return;
  }

  if (data.kind === "question-done") {
    const track = pendingQuestions.get(data.requestID);
    if (!track) {
      await answerCallback(cb.id, "Pergunta já resolvida");
      return;
    }
    const q = track.request.questions[data.qIndex];
    const sel = track.selections[data.qIndex];
    if (sel.length === 0) {
      await answerCallback(cb.id, "Escolhe pelo menos uma opção");
      return;
    }
    track.answers[data.qIndex] = sel.map((i: number) => q.options[i]?.label);
    await answerCallback(cb.id, "Ok");
    await completeQuestion(data.requestID, track);
  }
}

async function replyPermission(
  requestID: string,
  reply: "once" | "always" | "reject",
  chatId: number,
  messageId: number,
  callbackId: string,
) {
  await api({
    method: "POST",
    url: `/permission/${requestID}/reply`,
    body: { reply },
  });
  await editMessageText(chatId, messageId, core.permissionResultText(reply), null);
  await answerCallback(callbackId, "Feito");
  pendingPermissions.delete(requestID);
}

// ---------------------------------------------------------------------------
// Long-polling
// ---------------------------------------------------------------------------

async function pollLoop() {
  let offset = 0;
  let consecutive409 = 0;
  while (!stopPolling) {
    let data: any;
    try {
      data = await tg("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
    } catch {
      await sleep(2000);
      continue;
    }
    if (data.ok === false) {
      if (data.error_code === 409) {
        consecutive409 += 1;
        if (consecutive409 >= 3) {
          console.error(
            "[telegram] 409: outra instância está a fazer polling. Polling desligado (limite de 1 instância).",
          );
          return;
        }
        await sleep(5000);
        continue;
      }
      console.error("[telegram] getUpdates:", data.description ?? data.error_code);
      await sleep(2000);
      continue;
    }
    consecutive409 = 0;
    for (const u of data.result ?? []) {
      offset = Math.max(offset, (u.update_id ?? 0) + 1);
      if (u.message) await handleMessage(u.message);
      if (u.callback_query) await handleCallback(u.callback_query);
    }
  }
}

// ---------------------------------------------------------------------------
// Reconciliação no arranque (pedidos pendentes de um restart do plugin)
// ---------------------------------------------------------------------------

async function reconcile() {
  try {
    const permissions = (await api({ method: "GET", url: "/permission" })) as any[];
    for (const req of permissions ?? []) {
      if (!sentRequests.has(req.id)) {
        sentRequests.add(req.id);
        await notifyPermission(req, true);
      }
    }
    const questions = (await api({ method: "GET", url: "/question" })) as any[];
    for (const req of questions ?? []) {
      if (!sentRequests.has(req.id)) {
        sentRequests.add(req.id);
        await notifyQuestion(req, true);
      }
    }
  } catch (err) {
    console.error("[telegram] reconcile:", err);
  }
}

// ---------------------------------------------------------------------------
// Export único: a função do plugin (loader trata cada export de função como plugin)
// ---------------------------------------------------------------------------

export const telegram: Plugin = async (ctx) => {
  client = ctx.client;
  directory = ctx.directory;
  await loadState();

  if (!token) {
    console.error(
      "[telegram] Sem token. Configura com: loop-development telegram setup (ou env OPENCODE_TELEGRAM_BOT_TOKEN)",
    );
    return {};
  }
  if (state.allowedChatIds.length === 0) {
    console.error(
      "[telegram] Sem chats autorizados. Envia /start <chave> ao bot (ver: loop-development telegram status)",
    );
  } else {
    void reconcile();
  }
  void pollLoop();

  return {
    event: async ({ event }: any) => {
      try {
        if (event.type === "permission.asked") {
          const req = event.properties;
          if (!sentRequests.has(req.id)) {
            sentRequests.add(req.id);
            await notifyPermission(req, false);
          }
        } else if (event.type === "question.asked") {
          const req = event.properties;
          if (!sentRequests.has(req.id)) {
            sentRequests.add(req.id);
            await notifyQuestion(req, false);
          }
        }
      } catch (err) {
        console.error("[telegram] event:", err);
      }
    },
    dispose: async () => {
      stopPolling = true;
    },
  };
};
