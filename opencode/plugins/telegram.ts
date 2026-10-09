import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import type { Plugin } from "@opencode/plugin";
import * as core from "./core/telegram-core.js";
import { eventPayload, eventRequestID, eventSessionID, isLocalEvent } from "./core/events.js";

// Plugin: aprovações de permissões via Telegram.
// - Long-polling getUpdates (funciona atrás de NAT, sem portas públicas).
// - Apenas chats autorizados (emparelhamento com /start <chave>).
// - Limite de 1 instância a fazer polling (409 encerra o polling).
//
// V2: as permissões passaram a ser session-scoped. Não existe lista global de
// pedidos, por isso:
//   - a notificação vem do evento `permission.v2.asked` (com fallback para o
//     legado `permission.asked`), que traz o sessionID;
//   - a resposta usa ctx.permission.reply({ sessionID, requestID, decision });
//   - a reconciliação no arranque itera as sessões conhecidas (guardadas em
//     telegram-state.json), já que ctx.session não expõe list().
//
// Perguntas: o V2 não expõe um domínio question/form a plugins de servidor (só a
// API de CLI/TUI tem session.form.reply). Como o Telegram tem de funcionar 24/7,
// independente de o TUI estar aberto, este continua a ser server plugin e as
// perguntas passam a ser apenas notificadas, sem resposta remota.
//
// O import acima é só de tipos: apagado em runtime, sem dependências.

const TELEGRAM_API = "https://api.telegram.org";
const MAX_TRACKED_SESSIONS = 50;
const MAX_SEEN_REQUESTS = 500;

function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode");
  return join(homedir(), ".config", "opencode");
}

const STATE_FILE = join(configDir(), "telegram-state.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TelegramState {
  token?: string;
  pairingKey: string | null;
  allowedChatIds: number[];
  knownSessions: string[];
}

async function loadState(): Promise<TelegramState> {
  const state: TelegramState = { token: undefined, pairingKey: null, allowedChatIds: [], knownSessions: [] };
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      state.token = parsed.token;
      state.pairingKey = parsed.pairingKey ?? null;
      state.allowedChatIds = Array.isArray(parsed.allowedChatIds) ? parsed.allowedChatIds : [];
      state.knownSessions = Array.isArray(parsed.knownSessions) ? parsed.knownSessions : [];
    }
  } catch {
    // sem estado ainda
  }
  return state;
}

interface TelegramMessage {
  message_id?: number;
}

interface TelegramResponse {
  ok?: boolean;
  result?: TelegramMessage;
  description?: string;
}

async function tg(token: string, method: string, body: unknown): Promise<TelegramResponse> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as TelegramResponse;
}

async function sendMessage(token: string, chatId: number, text: string, replyMarkup: unknown) {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const data = await tg(token, "sendMessage", body);
  return data.ok ? data.result : null;
}

// `replyMarkup === null` remove os botões; qualquer outro valor substitui-os.
async function editMessage(token: string, chatId: number, messageId: number, text: string, replyMarkup: unknown) {
  await tg(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  });
}

async function editMessageText(token: string, chatId: number, messageId: number, text: string) {
  await editMessage(token, chatId, messageId, text, null);
}

async function answerCallback(token: string, callbackQueryId: string, text: string) {
  await tg(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

const plugin: Plugin.Plugin = {
  id: "loop-development.telegram",

  async setup(ctx) {
    // Todo o estado vive no closure de setup: no V2 o plugin é instanciado por
    // localização e estado module-level seria partilhado (e restarted).
    let state = await loadState();
    const token = process.env.OPENCODE_TELEGRAM_BOT_TOKEN || state.token || "";

    const saveState = async () => {
      try {
        await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
      } catch (err) {
        console.error("[telegram] gravar estado:", err);
      }
    };

    const authorized = (chatId: number) => core.isAuthorized(chatId, state.allowedChatIds);
    const projectName = () => core.baseName(ctx.location.directory);

    const pendingPermissions = new Map<string, ReturnType<typeof core.normalizePermissionRequest>>();
    const sentRequests = new Set<string>();
    const messageToPermission = new Map<string, string>();
    const warnedChats = new Set<number>();
    let stopping = false;

    const rememberSession = (sessionID: string) => {
      if (!sessionID || state.knownSessions.includes(sessionID)) return;
      state.knownSessions.push(sessionID);
      if (state.knownSessions.length > MAX_TRACKED_SESSIONS) {
        state.knownSessions = state.knownSessions.slice(-MAX_TRACKED_SESSIONS);
      }
    };

    const rememberRequest = (id: string) => {
      if (sentRequests.has(id)) return false;
      sentRequests.add(id);
      // O stream é de longa duração: sem limite, o Set cresce sem parar.
      if (sentRequests.size > MAX_SEEN_REQUESTS) sentRequests.clear();
      return true;
    };

    const notifyPermission = async (req: ReturnType<typeof core.normalizePermissionRequest>) => {
      if (!token || state.allowedChatIds.length === 0) return;
      pendingPermissions.set(req.id, req);
      const text = core.permissionText(req, projectName());
      for (const chatId of state.allowedChatIds) {
        const sent = await sendMessage(token, chatId, text, core.permissionKeyboard(req.id));
        if (sent?.message_id) messageToPermission.set(`${chatId}:${sent.message_id}`, req.id);
      }
    };

    const notifyQuestion = async (payload: { sessionID?: string; questions?: unknown[] } | null) => {
      if (!token || state.allowedChatIds.length === 0 || !payload) return;
      const questions = Array.isArray(payload.questions) ? payload.questions : [];
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const text = core.questionNoticeText(q, projectName(), i, questions.length);
        for (const chatId of state.allowedChatIds) {
          await sendMessage(token, chatId, text, null);
        }
      }
    };

    const replyPermission = async (
      sessionID: string,
      requestID: string,
      reply: "once" | "always" | "reject",
      chatId: number,
      messageId: number,
      callbackId: string,
    ) => {
      // O campo é `decision` (não `reply`) em PermissionReplyInput — confirmado
      // contra @opencode/client v2. O plano assumia `reply`.
      await ctx.permission.reply({ sessionID, requestID, decision: reply });
      await editMessageText(token, chatId, messageId, core.permissionResultText(reply));
      await answerCallback(token, callbackId, "Feito");
      pendingPermissions.delete(requestID);
    };

    // -----------------------------------------------------------------------
    // Mensagens do Telegram
    // -----------------------------------------------------------------------

    const handleMessage = async (msg: any) => {
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
            token,
            chatId,
            "✅ Emparelhado! A partir de agora recebes aqui os pedidos de permissão.",
            null,
          );
        } else {
          await sendMessage(token, chatId, "Chave inválida. Gera uma com: loop-development telegram setup", null);
        }
        return;
      }

      if (!authorized(chatId)) {
        if (!warnedChats.has(chatId)) {
          warnedChats.add(chatId);
          await sendMessage(token, chatId, "Não autorizado.", null);
        }
      }
    };

    const handleCallback = async (cb: any) => {
      const msg = cb?.message;
      const chatId = msg?.chat?.id;
      if (chatId == null || !authorized(chatId)) {
        if (cb?.id) await answerCallback(token, cb.id, "Não autorizado");
        return;
      }
      const data = core.parseCallbackData(cb?.data);
      if (!data) {
        await answerCallback(token, cb.id, "Ação desconhecida");
        return;
      }

      // Botões de pergunta podem ainda existir em mensagens enviadas antes da
      // migração para V2. Explicamos a limitação em vez de falhar.
      if (data.kind === "question-option" || data.kind === "question-done") {
        await answerCallback(token, cb.id, core.questionCallbackUnsupportedText());
        return;
      }

      if (data.kind === "permission-confirm") {
        const { requestID, confirmed } = data as any;
        const req = pendingPermissions.get(requestID);
        if (!req) {
          await answerCallback(token, cb.id, "Pedido já resolvido");
          return;
        }
        if (confirmed) {
          try {
            await replyPermission(req.sessionID, requestID, "always", chatId, msg.message_id, cb.id);
          } catch {
            await editMessageText(token, chatId, msg.message_id, "⚠️ Já respondido (noutra janela)");
            await answerCallback(token, cb.id, "Já respondido");
          }
        } else {
          // Volta ao teclado original dos botões Aprovar/Sempre/Rejeitar.
          await editMessage(
            token,
            chatId,
            msg.message_id,
            core.permissionText(req, projectName()),
            core.permissionKeyboard(requestID),
          );
          await answerCallback(token, cb.id, "Cancelado");
        }
        messageToPermission.delete(`${chatId}:${msg.message_id}`);
        return;
      }

      const { action, requestID } = data as any;
      const req = pendingPermissions.get(requestID);
      if (!req) {
        await answerCallback(token, cb.id, "Pedido já resolvido");
        return;
      }

      if (action === "always") {
        await editMessage(
          token,
          chatId,
          msg.message_id,
          core.permissionAlwaysConfirmText(req, projectName()),
          core.permissionAlwaysConfirmKeyboard(requestID),
        );
        await answerCallback(token, cb.id, "Confirma os padrões");
        return;
      }

      const reply = action === "reject" ? "reject" : "once";
      try {
        await replyPermission(req.sessionID, requestID, reply, chatId, msg.message_id, cb.id);
      } catch {
        await editMessageText(token, chatId, msg.message_id, "⚠️ Já respondido (noutra janela)");
        await answerCallback(token, cb.id, "Já respondido");
      }
      messageToPermission.delete(`${chatId}:${msg.message_id}`);
    };

    // -----------------------------------------------------------------------
    // Long-polling
    // -----------------------------------------------------------------------

    const pollLoop = async () => {
      let offset = 0;
      let consecutive409 = 0;
      while (!stopping) {
        let data: any;
        try {
          data = await tg(token, "getUpdates", {
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
          try {
            if (u.message) await handleMessage(u.message);
            if (u.callback_query) await handleCallback(u.callback_query);
          } catch (err) {
            console.error("[telegram] update:", err);
          }
        }
      }
    };

    // -----------------------------------------------------------------------
    // Reconciliação no arranque
    // -----------------------------------------------------------------------
    //
    // Não existe lista global de pedidos em V2, por isso percorremos as sessões
    // que já conhecemos. Uma sessão só entra na lista depois de um evento, o que
    // significa que pedidos de sessões nunca vistas não são reconciliados — é a
    // contrapartida de não haver API global.
    const reconcile = async () => {
      for (const sessionID of state.knownSessions) {
        try {
          const pending = await ctx.permission.list({ sessionID });
          for (const raw of pending ?? []) {
            const req = core.normalizePermissionRequest(raw);
            if (!req.id || !rememberRequest(req.id)) continue;
            await notifyPermission(req);
          }
        } catch (err) {
          console.error("[telegram] reconciliar:", err);
        }
      }
    };

    if (!token) {
      console.error(
        "[telegram] Sem token. Configura com: loop-development telegram setup (ou env OPENCODE_TELEGRAM_BOT_TOKEN)",
      );
      return () => {
        stopping = true;
      };
    }
    if (state.allowedChatIds.length === 0) {
      console.error(
        "[telegram] Sem chats autorizados. Envia /start <chave> ao bot (ver: loop-development telegram status)",
      );
    } else {
      void reconcile();
    }
    void pollLoop();

    // -----------------------------------------------------------------------
    // Eventos do OpenCode
    // -----------------------------------------------------------------------

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (!isLocalEvent(event, ctx.location.directory)) continue;
            const payload = eventPayload(event) as any;

            // No V2 o único evento de permissão é `permission.asked`, com o
            // envelope em `data`. O ramo `.v2.asked` do plano não existe no
            // schema de 2.0.11 (verificado em @opencode/schema/event-manifest).
            if (event.type === "permission.asked") {
              const req = core.normalizePermissionRequest(payload);
              if (!req.id || !rememberRequest(req.id)) continue;
              rememberSession(req.sessionID);
              await saveState();
              await notifyPermission(req);
            } else if (event.type === "form.created") {
              // Perguntas no V2 são forms, não o evento `question.*` do plano.
              // Notificamos sem botões: responder exige o TUI (§2.5).
              if (!rememberRequest(eventRequestID(event))) continue;
              rememberSession(eventSessionID(event));
              await saveState();
              await notifyQuestion(payload);
            }
          } catch (err) {
            console.error("[telegram] evento:", err);
          }
        }
      } catch (err) {
        console.error("[telegram] stream:", err);
      }
    })();

    return () => {
      stopping = true;
      controller.abort();
    };
  },
};

export default plugin;