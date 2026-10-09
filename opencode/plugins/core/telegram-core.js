// Lógica pura e testável do plugin Telegram (sem I/O, sem dependências do opencode).
// Importado por telegram.ts (plugin) e pelos testes em test/telegram.test.js.

export function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : String(id ?? "");
}

export function baseName(path) {
  return String(path ?? "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() ?? "projeto";
}

export function formatAlwaysPatterns(patterns) {
  const list = Array.isArray(patterns) ? patterns.filter(Boolean) : [];
  return list.length > 0 ? list.join(", ") : "(padrões não propostos)";
}

export function isAuthorized(chatId, allowedChatIds) {
  return Array.isArray(allowedChatIds) && allowedChatIds.includes(chatId);
}

// ---------------------------------------------------------------------------
// Normalização de eventos de permissão
// ---------------------------------------------------------------------------
//
// O V2 publica dois dialectos em paralelo e o plugin tem de lidar com ambos:
//   permission.v2.asked → { id, sessionID, action, resources, save }
//   permission.asked    → { id, sessionID, permission, patterns, always }
// Os dados chegam em `event.data` na geração nova e `event.properties` na
// legada. Reduzimos ambos a uma única forma:
// { id, sessionID, action, resources, always }.

export function normalizePermissionRequest(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const action = src.action ?? src.permission ?? "";
  const resources = Array.isArray(src.resources)
    ? src.resources
    : Array.isArray(src.patterns)
      ? src.patterns
      : [];
  const always = Array.isArray(src.save) ? src.save : Array.isArray(src.always) ? src.always : [];
  return {
    id: src.id ?? src.requestID ?? "",
    sessionID: src.sessionID ?? "",
    action: typeof action === "string" ? action : String(action ?? ""),
    resources: resources.filter((r) => typeof r === "string" && r.length > 0),
    always: always.filter((r) => typeof r === "string" && r.length > 0),
  };
}

// ---------------------------------------------------------------------------
// Encoding de callback_data (Telegram limita a 64 bytes)
// ---------------------------------------------------------------------------

export function permissionCallback(action, requestID) {
  return `p:${action}:${requestID}`;
}

export function permissionAlwaysConfirmCallback(requestID, confirmed) {
  return `pc:${confirmed ? 1 : 0}:${requestID}`;
}

export function questionOptionCallback(requestID, qIndex, optionIndex, mode) {
  return `q:${mode}:${requestID}:${qIndex}:${optionIndex}`;
}

export function questionDoneCallback(requestID, qIndex) {
  return `qd:${requestID}:${qIndex}`;
}

export function parseCallbackData(data) {
  const parts = String(data ?? "").split(":");
  const tag = parts[0];
  if (tag === "p") return { kind: "permission", action: parts[1], requestID: parts[2] };
  if (tag === "pc")
    return { kind: "permission-confirm", confirmed: parts[1] === "1", requestID: parts[2] };
  if (tag === "q")
    return {
      kind: "question-option",
      mode: parts[1],
      requestID: parts[2],
      qIndex: Number(parts[3]),
      optionIndex: Number(parts[4]),
    };
  if (tag === "qd")
    return { kind: "question-done", requestID: parts[1], qIndex: Number(parts[2]) };
  return null;
}

// ---------------------------------------------------------------------------
// Mensagens e teclados inline
// ---------------------------------------------------------------------------

export function permissionText(req, project) {
  const n = normalizePermissionRequest(req);
  const lines = [`🔒 Permissão pedida — ${project}`];
  if (n.action) lines.push(`Ferramenta: ${n.action}`);
  if (n.resources.length > 0) lines.push(`Recurso: ${n.resources.join(", ")}`);
  lines.push(`Sessão: ${shortId(n.sessionID)}`);
  return lines.join("\n");
}

export function permissionKeyboard(requestID) {
  return {
    inline_keyboard: [
      [{ text: "✅ Aprovar", callback_data: permissionCallback("once", requestID) }],
      [{ text: "🔁 Sempre", callback_data: permissionCallback("always", requestID) }],
      [{ text: "❌ Rejeitar", callback_data: permissionCallback("reject", requestID) }],
    ],
  };
}

export function permissionAlwaysConfirmText(req, project) {
  return `${permissionText(req, project)}\n\nGuardar estes padrões para SEMPRE?\n${formatAlwaysPatterns(normalizePermissionRequest(req).always)}`;
}

export function permissionAlwaysConfirmKeyboard(requestID) {
  return {
    inline_keyboard: [
      [
        {
          text: "✓ Sim, guardar sempre",
          callback_data: permissionAlwaysConfirmCallback(requestID, true),
        },
        {
          text: "✗ Cancelar",
          callback_data: permissionAlwaysConfirmCallback(requestID, false),
        },
      ],
    ],
  };
}

export function permissionResultText(action) {
  if (action === "once") return "✅ Aprovado (uma vez)";
  if (action === "always") return "🔁 Aprovado para sempre";
  return "❌ Rejeitado";
}

export function questionText(q, project, index = 0, total = 1) {
  const lines = [`❓ Pergunta — ${project}`];
  if (q?.header) lines.push(q.header);
  if (total > 1) lines.push(`(${index + 1}/${total})`);
  lines.push(q?.question ?? "");
  if (q?.multiple) lines.push("(podes escolher várias opções)");
  if (q?.custom !== false) lines.push("💬 Ou responde a esta mensagem com o teu texto.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Perguntas: apenas notificação
// ---------------------------------------------------------------------------
//
// Os plugins de servidor do V2 não têm domínio `question`/`form` — só a API de
// CLI/TUI expõe `session.form.reply`. Como o Telegram tem de funcionar 24/7
// (independente de o TUI estar aberto), fica como server plugin e as perguntas
// passam a ser só informativo.

export const QUESTION_UNSUPPORTED_HINT =
  "⚠️ No OpenCode V2 as perguntas não podem ser respondidas pelo Telegram — responde no TUI.";

export function questionNoticeText(q, project, index = 0, total = 1) {
  const lines = [`❓ Pergunta — ${project}`];
  if (q?.header) lines.push(q.header);
  if (total > 1) lines.push(`(${index + 1}/${total})`);
  lines.push(q?.question ?? "");
  if (q?.multiple) lines.push("(aceita várias opções)");
  const opts = Array.isArray(q?.options) ? q.options : [];
  if (opts.length > 0) lines.push(...opts.map((o, i) => `  ${i + 1}. ${o?.label ?? i}`));
  lines.push(QUESTION_UNSUPPORTED_HINT);
  return lines.join("\n");
}

// Resposta a botões de pergunta que ficaram em mensagens antigas (enviadas
// antes da migração para V2) — não é erro, é uma limitação conhecida.
export function questionCallbackUnsupportedText() {
  return "Perguntas remotas não suportadas no V2 — responde no TUI";
}

export function questionKeyboard(requestID, qIndex, question, selection = []) {
  const opts = question?.options ?? [];
  if (opts.length === 0) return null;
  const sel = Array.isArray(selection) ? selection : [];
  const rows = opts.map((opt, i) => {
    const checked = sel.includes(i);
    return [
      {
        text: `${checked ? "☑️" : "⬜️"} ${opt?.label ?? i}`,
        callback_data: questionOptionCallback(
          requestID,
          qIndex,
          i,
          question.multiple ? "multi" : "once",
        ),
      },
    ];
  });
  if (question?.multiple)
    rows.push([{ text: "✅ Concluir", callback_data: questionDoneCallback(requestID, qIndex) }]);
  return { inline_keyboard: rows };
}

export function questionAnsweredText() {
  return "✅ Respondido";
}

export function emptyKeyboard() {
  return { inline_keyboard: [] };
}
