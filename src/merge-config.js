import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { AGENT_NAME, INTERNAL_AGENTS, INTERNAL_READ_AGENTS, PERMISSION_KEYS, EXECUTION_AGENTS, STALE_AGENT_KEYS } from "./constants.js";

export const MANAGED_KEYS = [
  `agent.${AGENT_NAME}.permission.task`,
  ...PERMISSION_KEYS.map((k) => `agent.${AGENT_NAME}.permission.${k}`),
  ...INTERNAL_AGENTS.flatMap((name) =>
    PERMISSION_KEYS.map((k) => `agent.${name}.permission.${k}`)
  ),
  ...INTERNAL_READ_AGENTS.flatMap((name) =>
    PERMISSION_KEYS.filter((k) => k !== "edit").map((k) => `agent.${name}.permission.${k}`)
  ),
  ...EXECUTION_AGENTS.flatMap((name) => [`agent.${name}.permission.bash`])
];

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
        } else if (target[k] !== v) {
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

export async function mergeConfigFile(configDir, baseConfig, { dryRun = false } = {}) {
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

  const removed = removeStaleAgents(config);
  const { config: merged, added, managed } = mergeManaged(config, baseConfig);
  const changed = added.length > 0 || managed.length > 0 || removed.length > 0;

  if (!changed || dryRun) {
    return { file, changed, backup: null, added, managed, removed };
  }

  let backup = null;
  if (existed) {
    backup = backupPath(file);
    await rename(file, backup);
  }
  await writeFile(file, serializeConfig(merged), "utf8");

  return { file, changed: true, backup, added, managed, removed };
}

function backupPath(file) {
  const base = `${file}.bak-loop-development`;
  return existsSync(base) ? `${base}.${Date.now()}` : base;
}
