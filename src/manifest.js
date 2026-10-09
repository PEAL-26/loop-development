import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MANIFEST_FILE = ".loop-development-manifest.json";
export const MANIFEST_VERSION = 2;

export function emptyManifest() {
  return {
    manifestVersion: MANIFEST_VERSION,
    version: null,
    installedAt: null,
    // v2: [{ path, sha256, shippedIn }] — permite distinguir "instalado numa
    // versão antiga" (refrescável) de "editado pelo utilizador" (intocável).
    files: [],
    configFile: null,
    // v2: [{ agent, action, resource, effect }] — identidade de regra em vez de
    // caminho de chave, porque as permissões passaram a ser um array ordenado.
    configAdded: [],
    configConflicts: [],
    configRemoved: []
  };
}

function normalizeFileEntry(entry) {
  if (typeof entry === "string") return { path: entry, sha256: null, shippedIn: null };
  if (entry && typeof entry === "object" && typeof entry.path === "string") {
    return { path: entry.path, sha256: entry.sha256 ?? null, shippedIn: entry.shippedIn ?? null };
  }
  return null;
}

// Entradas v1 (`"agent.x.permission.read"` ou `{path, key}`) não casam com
// regras V2. Marcamo-las como legacy em vez de as descartar: `computeObsoleteCleanup`
// salta-as, e o uninstall simplesmente não remove nada por elas. A consequência é
// única e inofensiva — regras escritas pelo installer V1 ficam para trás uma vez.
function normalizeConfigEntry(entry) {
  if (typeof entry === "string") {
    const i = entry.lastIndexOf(".");
    return { legacy: true, path: entry.slice(0, i), key: entry.slice(i + 1) };
  }
  if (entry && typeof entry === "object") {
    if (typeof entry.action === "string" && typeof entry.resource === "string") {
      return {
        legacy: false,
        agent: entry.agent ?? entry.scope?.agent ?? null,
        action: entry.action,
        resource: entry.resource,
        effect: entry.effect ?? null,
      };
    }
    if (typeof entry.path === "string") return { legacy: true, path: entry.path, key: entry.key ?? null };
  }
  return null;
}

export function ruleIdentity(entry) {
  return `${entry?.agent ?? "-"}|${entry?.action}|${entry?.resource}`;
}

export function fileEntry(manifest, path) {
  return (manifest?.files ?? []).find((f) => f?.path === path) ?? null;
}

export async function loadManifest(configDir) {
  try {
    const raw = await readFile(join(configDir, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object") return emptyManifest();
    return {
      ...emptyManifest(),
      ...parsed,
      manifestVersion: parsed.manifestVersion ?? 1,
      files: (Array.isArray(parsed.files) ? parsed.files : []).map(normalizeFileEntry).filter(Boolean),
      configAdded: (Array.isArray(parsed.configAdded) ? parsed.configAdded : [])
        .map(normalizeConfigEntry)
        .filter(Boolean),
      configConflicts: Array.isArray(parsed.configConflicts) ? parsed.configConflicts : [],
      configRemoved: Array.isArray(parsed.configRemoved) ? parsed.configRemoved : [],
    };
  } catch {
    return emptyManifest();
  }
}

export async function saveManifest(configDir, manifest) {
  await writeFile(
    join(configDir, MANIFEST_FILE),
    JSON.stringify({ ...manifest, manifestVersion: MANIFEST_VERSION }, null, 2) + "\n",
    "utf8",
  );
}