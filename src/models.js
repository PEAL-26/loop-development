import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveConfigDir } from "./config-dir.js";

export const MODELS_CATALOG_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 8000;

export async function fetchModelsCatalog() {
  try {
    const res = await fetch(MODELS_CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function splitModelId(model) {
  const idx = model.indexOf("/");
  if (idx === -1) return { provider: null, id: model.trim() };
  return { provider: model.slice(0, idx), id: model.slice(idx + 1) };
}

export function lookupModel(catalog, model) {
  if (!catalog) return null;
  const { provider, id } = splitModelId(model);
  if (!provider) return null;
  const providerEntry = catalog[provider];
  if (!providerEntry?.models) return null;
  return providerEntry.models[id] ?? null;
}

export function isModelFree(entry) {
  if (!entry) return false;
  const cost = entry.cost;
  if (!cost) return false;
  return Number(cost.input) === 0 && Number(cost.output) === 0;
}

export function describeModel(model, catalog) {
  if (!catalog) return { model, status: "unknown" };
  const entry = lookupModel(catalog, model);
  if (!entry) return { model, status: "not-found" };
  if (entry.status === "deprecated") return { model, status: "deprecated" };
  return { model, status: "ok", entry };
}

function extractModel(content) {
  const match = content.match(/^model: (.*)$/m);
  return match ? match[1].trim() : null;
}

export async function auditInstalledModels({ configDir, log = () => {} } = {}) {
  const dir = resolveConfigDir(configDir);
  const agentsDir = join(dir, "agents");
  if (!existsSync(agentsDir)) {
    throw new Error(`Nenhum agente instalado em ${agentsDir}. Corre "npx loop-development init" primeiro.`);
  }

  const catalog = await fetchModelsCatalog();
  if (!catalog) {
    log("Aviso: não foi possível consultar o catálogo em models.dev (offline?) — a auditoria fica sem validação externa.");
  }

  const models = [];
  for (const name of await readdir(agentsDir)) {
    if (!name.endsWith(".md")) continue;
    const content = await readFile(join(agentsDir, name), "utf8");
    const model = extractModel(content);
    if (!model) continue;
    const described = describeModel(model, catalog);
    models.push({ agent: name.replace(/\.md$/, ""), ...described });
  }
  return models;
}

export async function checkModel(model, catalog) {
  const described = describeModel(model, catalog);
  if (described.status === "not-found") {
    return { ok: false, message: `modelo "${model}" não encontrado no catálogo models.dev. Confirma o id com /models no OpenCode.` };
  }
  if (described.status === "deprecated") {
    return { ok: false, message: `modelo "${model}" está marcado como deprecated no models.dev. Confirma se ainda funciona com /models no OpenCode.` };
  }
  if (described.status === "unknown") {
    return { ok: true, message: null };
  }
  return { ok: true, message: null };
}
