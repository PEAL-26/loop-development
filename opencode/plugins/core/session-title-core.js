// Lógica pura e testável do plugin de título de sessão (sem I/O, sem
// dependências do opencode). Importado por session-title.ts (plugin) e pelos
// testes em test/session-title.test.js.

export function stripJsonc(text) {
  const kept = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

    let stripped = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inString) {
        stripped += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
        stripped += ch;
      } else if (ch === "/" && line[i + 1] === "/") {
        break;
      } else {
        stripped += ch;
      }
    }
    kept.push(stripped);
  }
  return kept.join("\n");
}

export function parseJson(text) {
  return JSON.parse(stripJsonc(text));
}

export function defaultConfig() {
  return {
    enabled: true,
    agents: ["loop-development"],
    prefix: "",
    suffix: "",
    mode: "first", // "first" | "always" | "never"
    debug: false,
  };
}

export function mergeConfig(partial) {
  const base = defaultConfig();
  const incoming = partial && typeof partial === "object" ? partial : {};
  return {
    enabled: incoming.enabled ?? base.enabled,
    agents: Array.isArray(incoming.agents) ? incoming.agents : base.agents,
    prefix: String(incoming.prefix ?? base.prefix),
    suffix: String(incoming.suffix ?? base.suffix),
    mode: ["first", "always", "never"].includes(incoming.mode) ? incoming.mode : base.mode,
    debug: Boolean(incoming.debug ?? base.debug),
  };
}

export function activePlanId(state) {
  if (!state || typeof state !== "object") return null;
  return state.active_plan ?? state.activePlan ?? null;
}

// Deriva um nome legível do id do plano: remove o prefixo de timestamp
// (YYYYMMDD.HHMM-) e transforma kebab/snake em Title Case.
// Ex: "20260808.2246-login-google" -> "Login Google".
export function planDisplayName(id) {
  const raw = String(id ?? "").trim();
  if (!raw) return "";
  const stripped = raw.replace(/^\d{8}\.\d{4}-/, "");
  const words = stripped.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return raw;
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function computeTitle(planId, prefix = "", suffix = "") {
  const name = planDisplayName(planId);
  if (!name) return "";
  return `${prefix}${name}${suffix}`;
}

export function isDefaultTitle(title) {
  const t = String(title ?? "").trim();
  return t === "" || /^(Nova sessão|New session)/.test(t);
}

export function decideAction({ config, agent, activePlan, currentTitle, lastSetTitle }) {
  const cfg = mergeConfig(config);
  if (!cfg.enabled) return { action: "skip", reason: "disabled" };
  if (cfg.agents.length > 0 && !cfg.agents.includes(agent)) {
    return { action: "skip", reason: "agent" };
  }
  if (!activePlan) return { action: "skip", reason: "no-plan" };

  const title = computeTitle(activePlan, cfg.prefix, cfg.suffix);
  if (!title) return { action: "skip", reason: "empty-title" };
  if (currentTitle === title) return { action: "skip", reason: "already" };

  if (cfg.mode === "never") {
    if (isDefaultTitle(currentTitle)) return { action: "set", title, reason: "default" };
    return { action: "skip", reason: "manual" };
  }
  if (cfg.mode === "always") return { action: "set", title, reason: "always" };

  // mode "first": sobrescreve na 1ª vez e mantém enquanto o título atual ainda
  // for o que escrevemos (ou um default). Renomes manuais ficam intactos.
  if (lastSetTitle === undefined) return { action: "set", title, reason: "first" };
  if (currentTitle === lastSetTitle) return { action: "set", title, reason: "update" };
  if (isDefaultTitle(currentTitle)) return { action: "set", title, reason: "reset" };
  return { action: "skip", reason: "manual" };
}

// ---------------------------------------------------------------------------
// Estado persistente: .loop-development/session-titles.json
// { version: 1, titles: { [sessionID]: { title, plan, updatedAt } } }
// ---------------------------------------------------------------------------

export function emptyState() {
  return { version: 1, titles: {} };
}

export function parseState(text) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return {
      version: 1,
      titles: parsed && typeof parsed.titles === "object" && parsed.titles ? parsed.titles : {},
    };
  } catch {
    return emptyState();
  }
}

export function serializeState(state) {
  return JSON.stringify(state ?? emptyState(), null, 2) + "\n";
}

export function lastTitleFor(state, sessionID) {
  return state?.titles?.[sessionID]?.title;
}

export function updateLastTitle(state, sessionID, title, plan = null, now = Date.now()) {
  const base = state && typeof state === "object" ? state : emptyState();
  return {
    ...base,
    titles: {
      ...(base.titles ?? {}),
      [sessionID]: { title, plan: plan ?? null, updatedAt: now },
    },
  };
}
