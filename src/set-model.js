import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveConfigDir } from "./config-dir.js";
import { fetchModelsCatalog, checkModel } from "./models.js";

export const TIERS = ["reasoning", "coding", "docs", "mechanical"];

export const TIER_ALIASES = {
  execution: {
    target: "coding",
    deprecated: true
  }
};

export function resolveTier(tier) {
  if (TIERS.includes(tier)) return { tier };
  const alias = TIER_ALIASES[tier];
  if (alias) return { tier: alias.target, aliasOf: tier };
  throw new Error(`Tier inválido "${tier}". Válidos: ${TIERS.join(", ")}${Object.keys(TIER_ALIASES).length ? ` (alias deprecado: ${Object.keys(TIER_ALIASES).join(", ")})` : ""}`);
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

export async function setModel(tier, model, { configDir, dryRun = false, check = true, log = () => {} } = {}) {
  const { tier: resolvedTier, aliasOf } = resolveTier(tier);
  if (aliasOf) {
    log(`Aviso: o tier "${aliasOf}" foi renomeado. Usa "${resolvedTier}" a partir de agora — este alias será removido no futuro.`);
  }
  if (!model) {
    throw new Error(`Falta o modelo. Uso: loop-development set-model <${TIERS.join("|")}> <provider/modelo>`);
  }

  if (check) {
    const catalog = await fetchModelsCatalog();
    if (catalog) {
      const result = await checkModel(model, catalog);
      if (!result.ok) log(`Aviso: ${result.message}`);
    }
  }

  const dir = resolveConfigDir(configDir);
  const agentsDir = join(dir, "agents");
  if (!existsSync(agentsDir)) {
    throw new Error(`Nenhum agente instalado em ${agentsDir}. Corre "npx loop-development init" primeiro.`);
  }

  let changed = 0;
  for (const name of await readdir(agentsDir)) {
    if (!name.endsWith(".md")) continue;
    const file = join(agentsDir, name);
    const original = await readFile(file, "utf8");
    const updated = replaceModelForTier(original, resolvedTier, model);
    if (updated !== original) {
      if (!dryRun) await writeFile(file, updated, "utf8");
      changed += 1;
      log(`atualizado: ${name} -> ${model}`);
    }
  }

  if (changed === 0) {
    throw new Error(`Nenhum agente com tier "${resolvedTier}" encontrado. Tiers válidos: ${TIERS.join(", ")}`);
  }
  return changed;
}
