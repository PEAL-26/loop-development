import { homedir } from "node:os";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { findConfigFile, parseConfig, serializeConfig } from "./merge-config.js";

export const ALLOWED_FOLDERS_FILE = "allowed-folders.json";

export function allowedFoldersPath(projectDir) {
  return join(projectDir, ".loop-development", ALLOWED_FOLDERS_FILE);
}

export function toPosix(p) {
  return resolve(p).split(sep).join("/");
}

// Resolve o input para um caminho absoluto com separadores "/".
// Aceita caminhos absolutos, relativos ao cwd e com prefixo ~ (home).
export function normalizeExternalPath(input, cwd = process.cwd()) {
  let value = String(input).trim();
  if (value.startsWith("~")) {
    value = join(homedir(), value.slice(1));
  }
  return toPosix(resolve(cwd, value));
}

// Padrões opencode para cobrir a própria pasta e todo o seu conteúdo.
export function toExternalPatterns(normalizedPath) {
  return [normalizedPath, `${normalizedPath}/**`];
}

export async function loadAllowedFolders(projectDir) {
  try {
    const raw = await readFile(allowedFoldersPath(projectDir), "utf8");
    const data = JSON.parse(raw);
    return {
      version: data.version ?? 1,
      folders: Array.isArray(data.folders) ? data.folders : []
    };
  } catch {
    return { version: 1, folders: [] };
  }
}

export async function saveAllowedFolders(projectDir, data) {
  await mkdir(join(projectDir, ".loop-development"), { recursive: true });
  const body = JSON.stringify({ version: data.version ?? 1, folders: data.folders }, null, 2) + "\n";
  await writeFile(allowedFoldersPath(projectDir), body, "utf8");
}

export async function listAllowedFolders(projectDir = process.cwd(), log = console.log) {
  const list = await loadAllowedFolders(projectDir);
  if (list.folders.length === 0) {
    log("nenhuma pasta externa permitida");
    return list;
  }
  for (const f of list.folders) {
    const source = f.source ?? "manual";
    const added = f.addedAt ? `, desde ${f.addedAt}` : "";
    log(`${f.path}  (${source}${added})`);
  }
  return list;
}

// Lê o opencode.json do projeto, aplica fn ao objeto config e persiste com
// backup se algo mudou. fn devolve { changed, config }.
export async function updateProjectConfig(projectDir, fn, { dryRun = false } = {}) {
  const file = findConfigFile(projectDir);
  const existed = existsSync(file);
  let config = {};
  if (existed) {
    const raw = await readFile(file, "utf8");
    config = parseConfig(raw);
  }
  const { changed } = fn(config);
  if (!changed || dryRun) return { file, changed, backup: null };
  let backup = null;
  if (existed) {
    backup = backupPath(file);
    await rename(file, backup);
  }
  await writeFile(file, serializeConfig(config), "utf8");
  return { file, changed, backup };
}

function backupPath(file) {
  const base = `${file}.bak-loop-development`;
  return existsSync(base) ? `${base}.${Date.now()}` : base;
}

function ensureExternalDirectory(config) {
  if (config.permission == null || typeof config.permission !== "object") config.permission = {};
  const map = config.permission.external_directory;
  if (map == null || typeof map !== "object") config.permission.external_directory = {};
  return config.permission.external_directory;
}

// Merge aditivo de padrões em permission.external_directory. Nunca remove nem
// sobrepõe entradas que já existam (preserva regras manuais do utilizador).
export function addExternalDirectoryPatterns(config, patterns) {
  const map = ensureExternalDirectory(config);
  const added = [];
  for (const p of patterns) {
    if (!(p in map)) {
      map[p] = "allow";
      added.push(p);
    }
  }
  return { changed: added.length > 0, config, added };
}

export function removeExternalDirectoryPatterns(config, patterns) {
  const map = config?.permission?.external_directory;
  if (map == null || typeof map !== "object") return { changed: false, config, removed: [] };
  const removed = [];
  for (const p of patterns) {
    if (p in map) {
      delete map[p];
      removed.push(p);
    }
  }
  if (Object.keys(map).length === 0) {
    delete config.permission.external_directory;
    if (Object.keys(config.permission).length === 0) delete config.permission;
  }
  return { changed: removed.length > 0, config, removed };
}

// Aplica/remove padrões de external_directory no opencode.json do projeto.
export async function writeExternalDirectory(projectDir, { addPatterns = [], removePatterns = [], dryRun = false } = {}) {
  return updateProjectConfig(projectDir, (config) => {
    const add = addPatterns.length > 0 ? addExternalDirectoryPatterns(config, addPatterns) : { changed: false, added: [] };
    const remove = removePatterns.length > 0 ? removeExternalDirectoryPatterns(config, removePatterns) : { changed: false, removed: [] };
    return { changed: add.changed || remove.changed, config };
  }, { dryRun });
}

// Agentes internos com acesso a estado; servem para o alargamento defensivo
// de `**/.loop-development/**` (M003) quando o projeto não tem "*": "allow".
export const INTERNAL_STATE_AGENTS = [
  "loop-development",
  "context-loader",
  "state-manager",
  "planner-writer",
  "task-generator",
  "compacter",
  "refactorer",
  "documentation-writer",
  "final-reviewer"
];

// Alarga read/glob/edit (quando presentes) com `**/.loop-development/**` para
// os agentes internos que não tenham já "*": "allow". Defensivo: em projetos
// normais o installProject já dá "*": "allow" e isto é um no-op.
export function extendLoopDevPatterns(config) {
  const added = [];
  for (const agent of INTERNAL_STATE_AGENTS) {
    const perm = config?.agent?.[agent]?.permission;
    if (perm == null || typeof perm !== "object") continue;
    for (const key of ["read", "glob", "edit"]) {
      const map = perm[key];
      if (map == null || typeof map !== "object") continue;
      if ("*" in map) continue;
      if (!("**/.loop-development/**" in map)) {
        map["**/.loop-development/**"] = "allow";
        added.push(`agent.${agent}.permission.${key}`);
      }
    }
  }
  return { changed: added.length > 0, config, added };
}

export function shrinkLoopDevPatterns(config) {
  const removed = [];
  for (const agent of INTERNAL_STATE_AGENTS) {
    const perm = config?.agent?.[agent]?.permission;
    if (perm == null || typeof perm !== "object") continue;
    for (const key of ["read", "glob", "edit"]) {
      const map = perm[key];
      if (map == null || typeof map !== "object") continue;
      if ("**/.loop-development/**" in map) {
        delete map["**/.loop-development/**"];
        removed.push(`agent.${agent}.permission.${key}`);
      }
    }
  }
  return { changed: removed.length > 0, config, removed };
}

export async function addAllowedFolder({ projectDir = process.cwd(), path, source = "manual", dryRun = false, log = () => {} } = {}) {
  if (!path) throw new Error("caminho obrigatório");
  const normalized = normalizeExternalPath(path, projectDir);
  if (!existsSync(normalized)) throw new Error(`A pasta não existe: ${normalized}`);
  const list = await loadAllowedFolders(projectDir);
  if (list.folders.some((f) => f.path === normalized)) {
    log(`já permitida: ${normalized}`);
    return { changed: false, path: normalized, added: [] };
  }
  list.folders.push({ path: normalized, addedAt: new Date().toISOString(), source });
  if (!dryRun) await saveAllowedFolders(projectDir, list);
  const result = await writeExternalDirectory(projectDir, { addPatterns: toExternalPatterns(normalized), dryRun });
  if (result.changed) log(`external_directory: ${toExternalPatterns(normalized).join(", ")}`);
  return { changed: true, path: normalized, added: result.changed ? toExternalPatterns(normalized) : [] };
}

export async function removeAllowedFolder({ projectDir = process.cwd(), path, dryRun = false, log = () => {} } = {}) {
  if (!path) throw new Error("caminho obrigatório");
  const normalized = normalizeExternalPath(path, projectDir);
  const list = await loadAllowedFolders(projectDir);
  const before = list.folders.length;
  list.folders = list.folders.filter((f) => f.path !== normalized);
  if (list.folders.length === before) {
    log(`não está na lista: ${normalized}`);
    return { changed: false, path: normalized, removed: [] };
  }
  if (!dryRun) await saveAllowedFolders(projectDir, list);
  const result = await writeExternalDirectory(projectDir, { removePatterns: toExternalPatterns(normalized), dryRun });
  if (result.changed) log(`external_directory: ${toExternalPatterns(normalized).join(", ")} removidos`);
  return { changed: true, path: normalized, removed: toExternalPatterns(normalized) };
}

export async function clearAllowedFolders({ projectDir = process.cwd(), dryRun = false, log = () => {} } = {}) {
  const list = await loadAllowedFolders(projectDir);
  if (list.folders.length === 0) {
    log("lista vazia");
    return { changed: false, removed: [] };
  }
  const patterns = list.folders.flatMap((f) => toExternalPatterns(f.path));
  if (!dryRun) await saveAllowedFolders(projectDir, { version: list.version, folders: [] });
  const result = await writeExternalDirectory(projectDir, { removePatterns: patterns, dryRun });
  log(`removidas ${list.folders.length} pasta(s) permitida(s)`);
  return { changed: true, removed: list.folders.map((f) => f.path), configRemoved: result.changed };
}
