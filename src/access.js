import { homedir } from "node:os";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import {
  findConfigFile,
  parseConfig,
  serializeConfig,
  readRules,
  writeRules,
  insertRule,
  removeRule,
} from "./merge-config.js";

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

// No V2 as regras external_directory vivem no array `permissions` de topo, com
// action "external_directory" e o caminho como resource. O OpenCode expande ~
// e $HOME em recursos external_directory, por isso guardamos o caminho tal e
// qual.

// Merge aditivo. Nunca remove nem sobrepõe regras que já existam — preserva as
// regras manuais do utilizador.
export function addExternalDirectoryPatterns(config, patterns) {
  let rules = readRules(config, { agent: null });
  const added = [];
  for (const p of patterns) {
    const result = insertRule(rules, { action: "external_directory", resource: p, effect: "allow" });
    if (result.inserted) added.push(p);
    rules = result.rules;
  }
  writeRules(config, { agent: null }, rules);
  return { changed: added.length > 0, config, added };
}

export function removeExternalDirectoryPatterns(config, patterns) {
  let rules = readRules(config, { agent: null });
  const removed = [];
  for (const p of patterns) {
    const result = removeRule(rules, { action: "external_directory", resource: p, effect: "allow" });
    if (result.removed) removed.push(p);
    rules = result.rules;
  }
  writeRules(config, { agent: null }, rules);
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
// os agentes internos que não tenham já uma regra "*" allow. Defensivo: em
// projetos normais o installProject já dá "*" allow e isto é um no-op.
export function extendLoopDevPatterns(config) {
  const added = [];
  for (const agent of INTERNAL_STATE_AGENTS) {
    for (const action of ["read", "glob", "edit"]) {
      const scope = { agent };
      const rules = readRules(config, scope);
      // Uma regra "*" allow já cobre tudo; o objectivo do alargamento é
      // exactamente o caso em que o "*" não existe.
      if (rules.some((r) => r?.action === action && r?.resource === "*")) continue;
      const result = insertRule(rules, { action, resource: "**/.loop-development/**", effect: "allow" });
      if (!result.inserted) continue;
      writeRules(config, scope, result.rules);
      added.push(`${agent}:${action}`);
    }
  }
  return { changed: added.length > 0, config, added };
}

export function shrinkLoopDevPatterns(config) {
  const removed = [];
  for (const agent of INTERNAL_STATE_AGENTS) {
    for (const action of ["read", "glob", "edit"]) {
      const scope = { agent };
      const rules = readRules(config, scope);
      const result = removeRule(rules, {
        action,
        resource: "**/.loop-development/**",
        effect: "allow",
      });
      if (!result.removed) continue;
      writeRules(config, scope, result.rules);
      removed.push(`${agent}:${action}`);
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
