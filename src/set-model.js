import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveConfigDir } from "./config-dir.js";
import { fetchModelsCatalog, checkModel } from "./models.js";

export const TIERS = ["reasoning", "coding", "docs", "mechanical"];

export const DEFAULT_MODELS = {
  reasoning: "opencode/big-pickle",
  coding: "opencode/big-pickle",
  docs: "opencode/ling-3.0-tiny-free",
  mechanical: "opencode/deepseek-v4-flash-free"
};

export function resolveTier(tier) {
  if (TIERS.includes(tier)) return { tier };
  throw new Error(`Tier inválido "${tier}". Válidos: ${TIERS.join(", ")}`);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceModelForTier(content, tier, model) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return content;
  const fm = match[1];
  if (!new RegExp(`^# tier: ${escapeRegex(tier)}$`, "m").test(fm)) return content;
  return content.replace(fm, fm.replace(/^model: .*$/m, `model: ${model}`));
}

export async function setModels(models, { configDir, dryRun = false, check = true, log = () => {} } = {}) {
  const entries = Object.entries(models ?? {});
  if (entries.length === 0) throw new Error("Nenhum tier foi especificado.");

  const updates = {};
  for (const [tier, model] of entries) {
    const resolved = resolveTier(tier);
    if (typeof model !== "string" || !/^\S+\/\S+$/.test(model.trim())) {
      throw new Error(`Modelo inválido para o tier "${tier}". Usa o formato provider/model-id.`);
    }
    updates[resolved.tier] = model.trim();
  }

  if (check) {
    const catalog = await fetchModelsCatalog();
    if (catalog) {
      for (const model of new Set(Object.values(updates))) {
        const result = await checkModel(model, catalog);
        if (!result.ok) log(`Aviso: ${result.message}`);
      }
    } else {
      log("Aviso: não foi possível consultar o catálogo em models.dev (offline?) — a alteração fica sem validação externa.");
    }
  }

  const dir = resolveConfigDir(configDir);
  const agentsDir = join(dir, "agents");
  if (!existsSync(agentsDir)) {
    throw new Error(`Nenhum agente instalado em ${agentsDir}. Corre "npx loop-development init" primeiro.`);
  }

  const files = [];
  const matchedTiers = new Set();
  for (const name of await readdir(agentsDir)) {
    if (!name.endsWith(".md")) continue;
    const file = join(agentsDir, name);
    const original = await readFile(file, "utf8");
    const tierMatch = original.match(/^# tier: (\w+)$/m);
    const tier = tierMatch?.[1];
    if (!tier || !updates[tier]) continue;
    matchedTiers.add(tier);
    const updated = replaceModelForTier(original, tier, updates[tier]);
    files.push({ file, name, tier, original, updated });
  }

  for (const tier of Object.keys(updates)) {
    if (!matchedTiers.has(tier)) {
      throw new Error(`Nenhum agente com tier "${tier}" encontrado. Tiers válidos: ${TIERS.join(", ")}`);
    }
  }

  const changedFiles = files.filter(({ original, updated }) => updated !== original);
  const changedByTier = Object.fromEntries(TIERS.map((tier) => [tier, 0]));
  for (const { name, tier, original, updated } of files) {
    if (updated === original) continue;
    if (!dryRun) {
      log(`atualizado: ${name} -> ${updates[tier]}`);
    } else {
      log(`seria atualizado: ${name} -> ${updates[tier]}`);
    }
    changedByTier[tier] += 1;
  }

  if (!dryRun) {
    const written = [];
    try {
      for (const entry of changedFiles) {
        written.push(entry);
        await writeFile(entry.file, entry.updated, "utf8");
      }
    } catch (error) {
      for (const entry of written.reverse()) {
        await writeFile(entry.file, entry.original, "utf8");
      }
      throw new Error(`Falha ao atualizar modelos; alterações revertidas: ${error.message}`);
    }
  }

  const changed = changedFiles.length;
  log(`${changed}${dryRun ? " agente(s) seriam" : " agente(s)"} atualizados.`);
  for (const tier of TIERS) {
    if (updates[tier]) log(`  ${tier}: ${changedByTier[tier]}`);
  }
  return changed;
}

export async function setModel(tier, model, options = {}) {
  const resolved = resolveTier(tier);
  if (!model) {
    throw new Error(`Falta o modelo. Uso: loop-development set-model <${TIERS.join("|")}> <provider/modelo>`);
  }
  return setModels({ [resolved.tier]: model }, options);
}
