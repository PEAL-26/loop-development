import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveConfigDir } from "./config-dir.js";

export const TIERS = ["reasoning", "execution", "mechanical"];

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

export async function setModel(tier, model, { configDir, dryRun = false, log = () => {} } = {}) {
  if (!TIERS.includes(tier)) {
    throw new Error(`Tier inválido "${tier}". Válidos: ${TIERS.join(", ")}`);
  }
  if (!model) {
    throw new Error("Falta o modelo. Uso: loop-development set-model <reasoning|execution|mechanical> <provider/modelo>");
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
    const updated = replaceModelForTier(original, tier, model);
    if (updated !== original) {
      if (!dryRun) await writeFile(file, updated, "utf8");
      changed += 1;
      log(`atualizado: ${name} -> ${model}`);
    }
  }

  if (changed === 0) {
    throw new Error(`Nenhum agente com tier "${tier}" encontrado. Tiers válidos: ${TIERS.join(", ")}`);
  }
  return changed;
}
