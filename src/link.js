import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import {
  toPosix,
  toExternalPatterns,
  writeExternalDirectory,
  updateProjectConfig,
  extendLoopDevPatterns,
  shrinkLoopDevPatterns,
  normalizeExternalPath
} from "./access.js";

export const STATE_FILE = ".loop-development/state.json";

export async function loadProjectState(projectDir) {
  try {
    const raw = await readFile(join(projectDir, STATE_FILE), "utf8");
    const state = JSON.parse(raw);
    return state != null && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

export async function saveProjectState(projectDir, state) {
  await mkdir(join(projectDir, ".loop-development"), { recursive: true });
  const next = { ...state, last_updated: new Date().toISOString() };
  await writeFile(join(projectDir, STATE_FILE), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

// Um projeto ligável tem state.json válido: objecto com `version` e `plans[]`.
export function isValidLoopDevDir(dir) {
  const file = join(dir, STATE_FILE);
  if (!existsSync(file)) return false;
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    return state != null && typeof state === "object" && "version" in state && Array.isArray(state.plans);
  } catch {
    return false;
  }
}

// Sobe até maxDepth ancestrais à procura do main (o mais próximo vence).
export function findParentProject(projectDir, { maxDepth = 5 } = {}) {
  let cur = resolve(projectDir);
  let depth = 0;
  while (depth < maxDepth) {
    const parent = dirname(cur);
    if (parent === cur) return null;
    if (isValidLoopDevDir(parent)) return parent;
    cur = parent;
    depth += 1;
  }
  return null;
}

// Desce até maxDepth níveis abaixo de projectDir à procura de children válidos.
// Ignora pastas ocultas, node_modules e .git.
export async function findChildProjects(projectDir, { maxDepth = 1 } = {}) {
  const children = [];
  const stack = [{ dir: resolve(projectDir), depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    if (depth >= maxDepth) continue;
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (isValidLoopDevDir(full)) {
        children.push(full);
        continue;
      }
      stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return children;
}

export function defaultState(projectDir) {
  return {
    version: 2,
    active_plan: null,
    plans: [],
    default_mode: "complete",
    min_coverage: 80,
    created_at: new Date().toISOString(),
    last_updated: new Date().toISOString()
  };
}

async function ensureParentChildren(parentDir, childDir, dryRun) {
  const pState = await loadProjectState(parentDir);
  if (!pState) return null;
  const children = Array.isArray(pState.children) ? pState.children : [];
  const selfPath = toPosix(childDir);
  if (children.some((c) => c.path === selfPath)) return null;
  children.push({ path: selfPath, name: basename(childDir), linkedAt: new Date().toISOString() });
  pState.children = children;
  if (!dryRun) await saveProjectState(parentDir, pState);
  return selfPath;
}

async function dropFromParentChildren(parentDir, childPath, dryRun) {
  const pState = await loadProjectState(parentDir);
  if (!pState || !Array.isArray(pState.children)) return false;
  const next = pState.children.filter((c) => c.path !== childPath);
  if (next.length === pState.children.length) return false;
  pState.children = next;
  if (!dryRun) await saveProjectState(parentDir, pState);
  return true;
}

// Aplica no opencode.json do child a raiz do main como external_directory e o
// alargamento defensivo de **/.loop-development/** nos agentes internos.
async function applyParentGrants(childDir, parentRoot, dryRun) {
  const patterns = toExternalPatterns(parentRoot);
  const result = await writeExternalDirectory(childDir, { addPatterns: patterns, dryRun });
  const extended = await updateProjectConfig(childDir, (config) => extendLoopDevPatterns(config), { dryRun });
  return { patterns, configAdded: result.changed, extended: extended.changed };
}

async function removeParentGrants(childDir, parentRoot, dryRun) {
  const patterns = toExternalPatterns(parentRoot);
  await writeExternalDirectory(childDir, { removePatterns: patterns, dryRun });
  await updateProjectConfig(childDir, (config) => shrinkLoopDevPatterns(config), { dryRun });
  return patterns;
}

// Deteta a hierarquia e reconcilia parent/children no state.json + grants.
export async function link({ projectDir = process.cwd(), dryRun = false, applyGrants = true, log = () => {} } = {}) {
  const dir = resolve(projectDir);
  const existing = await loadProjectState(dir);
  const state = existing ?? defaultState(dir);
  const hadState = existing != null;
  const changes = {
    parent: null,
    parentCleared: false,
    parentChildrenAdded: null,
    childrenAdded: [],
    childrenRemoved: [],
    grants: []
  };

  // 1. Ligação ascendente (child -> main).
  const parent = findParentProject(dir);
  const stateParent = state.parent ?? null;
  if (parent) {
    const pInfo = { path: toPosix(parent), name: basename(parent), linkedAt: stateParent?.linkedAt ?? new Date().toISOString() };
    if (!stateParent || stateParent.path !== pInfo.path) {
      state.parent = pInfo;
      changes.parent = pInfo;
    }
    const registered = await ensureParentChildren(parent, dir, dryRun);
    if (registered) {
      changes.parentChildrenAdded = registered;
      log(`ligado como child de: ${parent}`);
    }
    if (applyGrants) {
      const grants = await applyParentGrants(dir, toPosix(parent), dryRun);
      changes.grants.push({ target: toPosix(parent), ...grants });
    }
  } else if (stateParent) {
    // Main stale (deixou de ser válido): limpa a referência e os grants.
    state.parent = null;
    changes.parentCleared = true;
    if (applyGrants) await removeParentGrants(dir, stateParent.path, dryRun);
    await dropFromParentChildren(stateParent.path, toPosix(dir), dryRun);
    log(`ligação com o main desfeita (main já não é válido): ${stateParent.path}`);
  }

  // 2. Descendentes (main -> children) + reconciliação de stale.
  const children = await findChildProjects(dir);
  const seen = new Set(children.map((c) => toPosix(c)));
  const known = Array.isArray(state.children) ? state.children : [];
  const knownByPath = new Map(known.map((c) => [c.path, c]));
  for (const child of children) {
    const cp = toPosix(child);
    if (!knownByPath.has(cp)) {
      known.push({ path: cp, name: basename(child), linkedAt: new Date().toISOString() });
      changes.childrenAdded.push(cp);
      log(`child detetado: ${cp}`);
    }
  }
  const reconciled = known.filter((c) => {
    if (!seen.has(c.path)) {
      const childDir = resolve(c.path);
      if (!isValidLoopDevDir(childDir)) {
        changes.childrenRemoved.push(c.path);
        return false;
      }
    }
    return true;
  });
  if (reconciled.length !== known.length || changes.childrenAdded.length > 0) {
    state.children = reconciled;
  }

  const stateChanged =
    !hadState ||
    changes.parent != null ||
    changes.parentCleared ||
    reconciled.length !== known.length ||
    changes.childrenAdded.length > 0;

  if (stateChanged) {
    if (!dryRun) await saveProjectState(dir, state);
  }

  if (!hadState && !dryRun) {
    log(`.loop-development/state.json criado em ${dir}`);
  }

  return changes;
}

// Desliga a ligação com o main (se target é o parent) ou com um child.
export async function unlink({ projectDir = process.cwd(), path, dryRun = false, log = () => {} } = {}) {
  if (!path) throw new Error("caminho obrigatório");
  const dir = resolve(projectDir);
  const target = normalizeExternalPath(path, projectDir);
  const state = await loadProjectState(dir);
  if (!state) throw new Error("projeto sem .loop-development/state.json");

  // target é o nosso main.
  const parentInfo = state.parent ?? null;
  if (parentInfo && parentInfo.path === target) {
    state.parent = null;
    if (!dryRun) await saveProjectState(dir, state);
    await removeParentGrants(dir, target, dryRun);
    await dropFromParentChildren(target, toPosix(dir), dryRun);
    log(`ligação desfeita com o main: ${target}`);
    return { role: "parent", target };
  }

  // target é um child nosso.
  const known = Array.isArray(state.children) ? state.children : [];
  const child = known.find((c) => c.path === target);
  if (child) {
    state.children = known.filter((c) => c.path !== target);
    if (!dryRun) await saveProjectState(dir, state);
    try {
      await removeParentGrants(resolve(target), toPosix(dir), dryRun);
    } catch {
      // best effort: o child pode ter sido apagado
    }
    log(`child desligado: ${target}`);
    return { role: "child", target };
  }

  throw new Error(`sem ligação para: ${target}`);
}
