import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { OBSOLETE_BASH_AGENTS, STALE_AGENT_KEYS, ACTION_RENAMES } from "./constants.js";

// ---------------------------------------------------------------------------
// Regras de permissão (V2)
// ---------------------------------------------------------------------------
//
// O V2 substituiu os mapas V1 (`agent.<n>.permission.<ação>` com um mapa de
// padrões) por uma lista ORDENADA de regras `{ action, resource, effect }`,
// onde vale a ÚLTIMA regra que casa. Isso muda a natureza do merge: já não
// podemos identificar uma permissão por caminho de chave, e não podemos
// sobrescrever a regra do utilizador (faria a reinserção mudar a ordem relativa
// face às outras regras dele). Passamos a identificar por identidade e a ser
// estritamente aditivos.
// ---------------------------------------------------------------------------

export function normalizeRule(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { action, resource, effect } = raw;
  if (typeof action !== "string" || !action) return null;
  if (typeof resource !== "string" || !resource) return null;
  if (typeof effect !== "string" || !effect) return null;
  return { action, resource, effect };
}

// Identidade de uma regra. O effect NÃO entra: o slot (action, resource) é o
// que ocupamos, e um effect diferente é um conflito reportado ao utilizador
// em vez de uma sobreposição silenciosa.
export function ruleKey(rule) {
  return `${rule?.action}|${rule?.resource}`;
}

export function scopeKey(scope) {
  const agent = scope?.agent;
  return agent ? `agent:${agent}` : "global";
}

export function readRules(config, scope) {
  const list = scope?.agent
    ? config?.agents?.[scope.agent]?.permissions
    : config?.permissions;
  return Array.isArray(list) ? list : [];
}

export function writeRules(config, scope, rules) {
  if (scope?.agent) {
    if (config.agents == null || typeof config.agents !== "object") config.agents = {};
    const entry = config.agents[scope.agent] ?? (config.agents[scope.agent] = {});
    if (rules.length === 0) delete entry.permissions;
    else entry.permissions = rules;
  } else if (rules.length === 0) {
    delete config.permissions;
  } else {
    config.permissions = rules;
  }
  return config;
}

// Política de ordem. Uma regra broad (resource "*") que chegue AO FIM de um
// array sombrearia excepções já existentes — é exactamente o que acontece com
// o grant de projeto, cujo "*" allow tem de preceder os "*.env" ask. Por isso:
//   - broad → depois da última broad da mesma acção, antes de qualquer
//     específica dessa acção;
//   - específica → ao fim, onde a prioridade é máxima.
export function insertRule(rules, rule) {
  const list = Array.isArray(rules) ? rules.slice() : [];
  const key = ruleKey(rule);
  const existing = list.findIndex((r) => ruleKey(r) === key);
  if (existing >= 0) return { rules: list, inserted: false, conflict: list[existing] };

  if (rule.resource === "*") {
    let lastBroad = -1;
    for (let i = 0; i < list.length; i++) {
      if (ruleKey(list[i]) === ruleKey({ action: rule.action, resource: "*" })) lastBroad = i;
    }
    if (lastBroad >= 0) {
      list.splice(lastBroad + 1, 0, rule);
      return { rules: list, inserted: true, conflict: null };
    }
    const firstSpecific = list.findIndex((r) => r?.action === rule.action);
    if (firstSpecific >= 0) {
      list.splice(firstSpecific, 0, rule);
      return { rules: list, inserted: true, conflict: null };
    }
  }

  list.push(rule);
  return { rules: list, inserted: true, conflict: null };
}

export function removeRule(rules, rule) {
  const list = Array.isArray(rules) ? rules.slice() : [];
  const key = ruleKey(rule);
  let i = list.findIndex((r) => ruleKey(r) === key && r.effect === rule.effect);
  if (i < 0) i = list.findIndex((r) => ruleKey(r) === key);
  if (i < 0) return { rules: list, removed: false };
  list.splice(i, 1);
  return { rules: list, removed: true };
}

// Regras geridas, derivadas da própria config base. Substitui a lista
// hardcoded de caminhos de chave (MANAGED_KEYS) que existia em V1.
export function collectManagedRules(baseConfig) {
  const rules = [];
  for (const raw of baseConfig?.permissions ?? []) {
    const rule = normalizeRule(raw);
    if (rule) rules.push({ scope: { agent: null }, ...rule });
  }
  for (const [agent, cfg] of Object.entries(baseConfig?.agents ?? {})) {
    for (const raw of cfg?.permissions ?? []) {
      const rule = normalizeRule(raw);
      if (rule) rules.push({ scope: { agent }, ...rule });
    }
  }
  return rules;
}

// Estritamente aditivo. Uma regra nossa que colida com uma do utilizador
// (mesmo action+resource, effect diferente) NÃO é aplicada: devolvemos o
// conflito para reporte.
export function mergeManaged(config, baseConfig) {
  const added = [];
  const conflicts = [];
  for (const managed of collectManagedRules(baseConfig)) {
    const scope = { agent: managed.scope.agent ?? null };
    const result = insertRule(readRules(config, scope), {
      action: managed.action,
      resource: managed.resource,
      effect: managed.effect,
    });
    writeRules(config, scope, result.rules);
    if (result.inserted) {
      added.push({ scope, action: managed.action, resource: managed.resource, effect: managed.effect });
    } else if (result.conflict && result.conflict.effect !== managed.effect) {
      conflicts.push({
        scope,
        action: managed.action,
        resource: managed.resource,
        kept: result.conflict.effect,
        ours: managed.effect,
      });
    }
  }
  return { config, added, conflicts };
}

export function removeRules(config, rules) {
  const removed = [];
  for (const entry of rules) {
    const scope = { agent: entry?.agent ?? null };
    const result = removeRule(readRules(config, scope), {
      action: entry?.action,
      resource: entry?.resource,
      effect: entry?.effect,
    });
    if (!result.removed) continue;
    writeRules(config, scope, result.rules);
    removed.push({ scope, action: entry.action, resource: entry.resource, effect: entry.effect });
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Migração V1 → V2
// ---------------------------------------------------------------------------

// Os mapas V1 punham "*" e os padrões específicos no mesmo nível; a ordem de
// inserção no object JSON reflectia a intenção (broad primeiro). No array V2 isso
// passa a ser significativo, por isso garantimos broad-antes-de-específico.
// Atravessar acções diferentes não importa: uma regra só casa com a sua acção.
export function orderMigratedRules(rules) {
  const broad = [];
  const specific = [];
  for (const rule of rules) {
    (rule.resource === "*" ? broad : specific).push(rule);
  }
  return [...broad, ...specific];
}

// Converte um mapa V1 `{ acção: { padrão: effect } }` em regras. Devolve também
// o que não foi possível converter, para o preservarmos em vez de o perder.
export function migratePermissionMap(perm) {
  const rules = [];
  const leftover = {};
  for (const [key, value] of Object.entries(perm)) {
    const action = ACTION_RENAMES[key] ?? key;
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      for (const [pattern, effect] of Object.entries(value)) {
        const rule = normalizeRule({ action, resource: pattern, effect });
        if (rule) rules.push(rule);
        else leftover[`${key}.${pattern}`] = value;
      }
    } else if (typeof value === "string") {
      const rule = normalizeRule({ action, resource: "*", effect: value });
      if (rule) rules.push(rule);
      else leftover[key] = value;
    } else {
      leftover[key] = value;
    }
  }
  return { rules: orderMigratedRules(rules), leftover };
}

function migrateAgentEntry(entry, report, name) {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const out = { ...entry };

  if (out.permission != null && typeof out.permission === "object" && !Array.isArray(out.permission)) {
    const { rules, leftover } = migratePermissionMap(out.permission);
    delete out.permission;
    if (rules.length > 0) {
      out.permissions = rules;
      report.push(`agents.${name}.permission → permissions (${rules.length} regra(s))`);
    }
    if (Object.keys(leftover).length > 0) {
      out.permission = leftover;
      report.push(`agents.${name}.permission: ${Object.keys(leftover).join(", ")} não migrável — preservado`);
    }
  }

  if (typeof out.prompt === "string") {
    out.system = out.prompt;
    delete out.prompt;
  }
  if ("disable" in out) {
    out.disabled = out.disable;
    delete out.disable;
  }
  return out;
}

// Idempotente: converte `agent` → `agents` e mapas `permission` →
// `permissions`, aplicando as renomeações de acção (bash→shell, task→subagent,
// write/patch→edit). Tudo o que não recognise fica preservado e é reportado,
// para o `doctor` o apanhar.
export function migrateV1ToV2(config) {
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    return { config, migrated: false, report: [] };
  }
  const report = [];
  let migrated = false;

  if (config.agent != null && typeof config.agent === "object" && !Array.isArray(config.agent)) {
    if (config.agents == null || typeof config.agents !== "object" || Array.isArray(config.agents)) {
      config.agents = {};
    }
    for (const [name, entry] of Object.entries(config.agent)) {
      if (config.agents[name] != null) {
        report.push(`agents.${name}: já existia em "agents"; a entrada V1 foi ignorada`);
        continue;
      }
      config.agents[name] = migrateAgentEntry(entry, report, name);
    }
    delete config.agent;
    migrated = true;
    report.push('"agent" → "agents"');
  }

  if (config.permission != null && typeof config.permission === "object" && !Array.isArray(config.permission)) {
    const { rules, leftover } = migratePermissionMap(config.permission);
    if (rules.length > 0) {
      let list = readRules(config, { agent: null });
      for (const rule of rules) list = insertRule(list, rule).rules;
      config.permissions = list;
      migrated = true;
      report.push(`"permission" → "permissions" (${rules.length} regra(s))`);
    }
    if (Object.keys(leftover).length > 0) {
      config.permission = leftover;
      report.push(`"permission": ${Object.keys(leftover).join(", ")} não migrável — preservado, revê com 'doctor'`);
    } else {
      delete config.permission;
    }
  }

  return { config, migrated, report };
}

// Artefacto de versões antigas do installer: as permissões acabavam aninhadas
// em `agent.permission`, o que o OpenCode lia como um agente chamado
// "permission". Em V2 isso seria `agents.permission`.
export function removeInvalidArtifacts(config) {
  const removed = [];
  if (config.agents != null && typeof config.agents === "object" && "permission" in config.agents) {
    delete config.agents.permission;
    removed.push("agents.permission");
  }
  return removed;
}

const STALE_SIGNATURE_KEYS = ["name", "description", "mode", "prompt"];

export function removeStaleAgents(config) {
  const removed = [];
  for (const name of STALE_AGENT_KEYS) {
    const entry = getPath(config, `agents.${name}`);
    if (entry == null || typeof entry !== "object") continue;
    if (STALE_SIGNATURE_KEYS.some((k) => k in entry)) {
      removeEntry(config, "agents", name);
      removed.push(`agents.${name}`);
    }
  }
  return removed;
}

// Regras de bash por-agente que versões antigas do installer geriam. Já não as
// gerimos (as permissões dos nossos agentes vivem no frontmatter dos .md), por
// isso limpamos as que o manifest registou como nossas.
export function computeObsoleteCleanup(manifest) {
  const entries = [...(manifest?.configAdded ?? []), ...(manifest?.configManaged ?? [])];
  const obsolete = new Set(OBSOLETE_BASH_AGENTS);
  const rules = [];
  for (const entry of entries) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry) || entry.legacy) continue;
    const agent = entry.agent ?? null;
    if (!agent || !obsolete.has(agent)) continue;
    if (entry.action !== "shell") continue;
    rules.push({ agent, action: "shell", resource: entry.resource, effect: entry.effect });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// JSON (inalterado — continua a ser o parse de JSONC do config)
// ---------------------------------------------------------------------------

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
  return kept.join("\n").replace(/,(\s*[}\]])/g, "$1");
}

export function parseConfig(text) {
  return JSON.parse(stripJsonc(text));
}

export function serializeConfig(config) {
  return JSON.stringify(config, null, 2) + "\n";
}

export function findConfigFile(configDir) {
  const json = join(configDir, "opencode.json");
  const jsonc = join(configDir, "opencode.jsonc");
  if (existsSync(json)) return json;
  if (existsSync(jsonc)) return jsonc;
  return json;
}

export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function removeEntry(config, path, key) {
  const map = getPath(config, path);
  if (map != null && typeof map === "object") delete map[key];

  const keys = path.split(".");
  for (let i = keys.length; i >= 1; i--) {
    const container = getPath(config, keys.slice(0, i).join("."));
    if (container != null && typeof container === "object" && Object.keys(container).length === 0) {
      if (i === 1) {
        delete config[keys[0]];
      } else {
        const parent = getPath(config, keys.slice(0, i - 1).join("."));
        if (parent && typeof parent === "object") delete parent[keys[i - 1]];
      }
    } else {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Merge do ficheiro
// ---------------------------------------------------------------------------

export async function mergeConfigFile(
  configDir,
  baseConfig,
  { dryRun = false, mode = "managed", removeRules: rulesToRemove = [] } = {},
) {
  await mkdir(configDir, { recursive: true });
  const file = findConfigFile(configDir);
  let config = {};
  const existed = existsSync(file);
  if (existed) {
    const raw = await readFile(file, "utf8");
    try {
      config = parseConfig(raw);
    } catch (err) {
      throw new Error(`Não foi possível ler o config existente ${file}: ${err.message}`);
    }
  }

  const report = [];
  let migration = { migrated: false };
  // Migramos em ambos os modos. Sem isto, um config de projeto ainda em V1 fica
  // ilegível para o V2: a intenção do utilizador (ex.: read "*" = ask) não é
  // vista por `readRules`, e os nossos grants entrariam como se não houvesse
  // nada — enfraquecendo uma regra dele. Migrar primeiro faz a intenção dele
  // aparecer no array V2, e `mergeManaged` passa a vê-la e a reportar conflito.
  // A migração é aditiva e idempotente, e o ficheiro é guardado em backup.
  migration = migrateV1ToV2(config);
  report.push(...migration.report);

  let added = [];
  let conflicts = [];
  let removed = [];

  if (mode === "managed") {
    const stale = removeStaleAgents(config);
    const artifacts = removeInvalidArtifacts(config);
    const obsolete = removeRules(config, rulesToRemove);
    const merged = mergeManaged(config, baseConfig);
    added = merged.added;
    conflicts = merged.conflicts;
    removed = [...stale, ...artifacts, ...obsolete.map((r) => `${scopeKey(r.scope)}:${ruleKey(r)}`)];
  } else {
    const merged = mergeManaged(config, baseConfig);
    added = merged.added;
    conflicts = merged.conflicts;
  }

  const changed = migration.migrated || added.length > 0 || removed.length > 0;

  if (!changed || dryRun) {
    return { file, changed, backup: null, added, conflicts, removed, report };
  }

  let backup = null;
  if (existed) {
    backup = backupPath(file);
    await rename(file, backup);
  }
  await writeFile(file, serializeConfig(config), "utf8");

  return { file, changed: true, backup, added, conflicts, removed, report };
}

function backupPath(file) {
  const base = `${file}.bak-loop-development`;
  return existsSync(base) ? `${base}.${Date.now()}` : base;
}