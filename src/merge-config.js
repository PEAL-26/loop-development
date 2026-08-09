import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { AGENT_NAME, INTERNAL_AGENTS, INTERNAL_READ_AGENTS, PERMISSION_KEYS, OBSOLETE_BASH_AGENTS, STALE_AGENT_KEYS } from "./constants.js";

export const MANAGED_KEYS = [
  `agent.${AGENT_NAME}.permission.task`,
  `agent.${AGENT_NAME}.permission.question`,
  ...PERMISSION_KEYS.map((k) => `agent.${AGENT_NAME}.permission.${k}`),
  ...INTERNAL_AGENTS.flatMap((name) =>
    PERMISSION_KEYS.map((k) => `agent.${name}.permission.${k}`)
  ),
  ...INTERNAL_READ_AGENTS.flatMap((name) =>
    PERMISSION_KEYS.filter((k) => k !== "edit").map((k) => `agent.${name}.permission.${k}`)
  ),
  "permission.bash"
];

// Chaves geridas de forma aditiva: só se acrescentam chaves em falta,
// nunca se sobrepõem valores que o utilizador já tenha definido.
export const MANAGED_ADDITIVE_KEYS = ["permission.bash"];

export function stripJsonc(text) {
  const kept = [];
  for (const line of text.split("\n")) {
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

function setPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
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

export function mergeManaged(config, baseConfig) {
  const added = [];
  const managed = [];
  for (const key of MANAGED_KEYS) {
    const baseValue = getPath(baseConfig, key);
    if (baseValue == null) continue;

    if (typeof baseValue === "object") {
      const additive = MANAGED_ADDITIVE_KEYS.includes(key);
      const existing = getPath(config, key);
      let target;
      if (existing != null && typeof existing === "object") {
        target = existing;
      } else if (existing != null) {
        target = { "*": existing };
        setPath(config, key, target);
        added.push({ path: key, key: "*" });
      } else {
        target = {};
        setPath(config, key, target);
      }

      for (const [k, v] of Object.entries(baseValue)) {
        if (!(k in target)) {
          target[k] = v;
          added.push({ path: key, key: k });
        } else if (!additive && target[k] !== v) {
          const previous = target[k];
          target[k] = v;
          managed.push({ path: key, key: k, previous });
        }
      }
    } else {
      const existing = getPath(config, key);
      if (existing === undefined) {
        setPath(config, key, baseValue);
        added.push(splitLeaf(key));
      } else if (existing !== baseValue) {
        setPath(config, key, baseValue);
        managed.push({ ...splitLeaf(key), previous: existing });
      }
    }
  }
  return { config, added, managed };
}

function splitLeaf(key) {
  const i = key.lastIndexOf(".");
  return { path: key.slice(0, i), key: key.slice(i + 1) };
}

const STALE_SIGNATURE_KEYS = ["name", "description", "mode", "prompt"];

export function removeStaleAgents(config) {
  const removed = [];
  for (const name of STALE_AGENT_KEYS) {
    const entry = getPath(config, `agent.${name}`);
    if (entry == null || typeof entry !== "object") continue;
    const isStale = STALE_SIGNATURE_KEYS.some((k) => k in entry);
    if (isStale) {
      removeEntry(config, "agent", name);
      removed.push(`agent.${name}`);
    }
  }
  return removed;
}

// Caminhos de chaves bash per-agent que o installer adicionou em versões
// antigas e que agora devem ser removidas para o default global valer.
export function computeObsoleteCleanup(manifest) {
  const paths = new Set();
  const tracked = [...(manifest?.configAdded ?? []), ...(manifest?.configManaged ?? [])].map(
    (a) => `${a.path}.${a.key}`
  );
  for (const name of OBSOLETE_BASH_AGENTS) {
    const p = `agent.${name}.permission.bash`;
    if (tracked.includes(p)) paths.add(p);
  }
  return [...paths];
}

export function removeConfigPaths(config, paths) {
  const removed = [];
  for (const p of paths) {
    const keys = p.split(".");
    let node = config;
    let present = true;
    for (const k of keys) {
      if (node == null || typeof node !== "object" || !(k in node)) {
        present = false;
        break;
      }
      node = node[k];
    }
    if (!present) continue;
    removeEntry(config, keys.slice(0, -1).join("."), keys[keys.length - 1]);
    removed.push(p);
  }
  return removed;
}

// Mescla puramente aditiva para o opencode.json do projeto: define uma chave
// (ex: agent.<nome>.permission.read) apenas se o utilizador ainda não a tiver.
// Regras explícitas do utilizador no projeto vencem sempre; nada é sobreposto.
export function mergeAdditiveConfig(config, baseConfig) {
  const added = [];
  for (const [agent, agentCfg] of Object.entries(baseConfig.agent ?? {})) {
    for (const [key, value] of Object.entries(agentCfg.permission ?? {})) {
      const path = `agent.${agent}.permission.${key}`;
      if (getPath(config, path) === undefined) {
        setPath(config, path, structuredClone(value));
        added.push({ path: `agent.${agent}.permission`, key });
      }
    }
  }
  return { config, added };
}

export async function mergeConfigFile(configDir, baseConfig, { dryRun = false, removePaths = [], additiveOnly = false } = {}) {
  await mkdir(configDir, { recursive: true });
  const file = findConfigFile(configDir);
  let config = {};
  let existed = existsSync(file);
  if (existed) {
    const raw = await readFile(file, "utf8");
    try {
      config = parseConfig(raw);
    } catch (err) {
      throw new Error(`Não foi possível ler o config existente ${file}: ${err.message}`);
    }
  }

  let added = [];
  let managed = [];
  let removed = [];
  if (additiveOnly) {
    ({ config, added } = mergeAdditiveConfig(config, baseConfig));
  } else {
    const removedStale = removeStaleAgents(config);
    const removedPaths = removeConfigPaths(config, removePaths);
    ({ config, added, managed } = mergeManaged(config, baseConfig));
    removed = [...removedStale, ...removedPaths];
  }
  const changed =
    added.length > 0 || managed.length > 0 || removed.length > 0;

  if (!changed || dryRun) {
    return { file, changed, backup: null, added, managed, removed };
  }

  let backup = null;
  if (existed) {
    backup = backupPath(file);
    await rename(file, backup);
  }
  await writeFile(file, serializeConfig(config), "utf8");

  return { file, changed: true, backup, added, managed, removed };
}

function backupPath(file) {
  const base = `${file}.bak-loop-development`;
  return existsSync(base) ? `${base}.${Date.now()}` : base;
}
