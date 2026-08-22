import { join } from "node:path";
import { loadProjectState, saveProjectState, STATE_FILE } from "./link.js";

export function isValidMode(value) {
  return value === "simple" || value === "complete";
}

export async function setMode(mode, { projectDir = process.cwd(), dryRun = false, log = () => {} } = {}) {
  if (!isValidMode(mode)) {
    throw new Error(`modo inválido "${mode}" — usa "simple" ou "complete"`);
  }
  const state = await loadProjectState(projectDir);
  if (!state) {
    throw new Error(`Sem ${STATE_FILE} em ${projectDir} — corre 'npx loop-development init --project' primeiro.`);
  }
  const previous = isValidMode(state.default_mode) ? state.default_mode : "complete";
  if (previous === mode) {
    log(`default_mode já é "${mode}". Nada a alterar.`);
    return { changed: false, previous, mode };
  }
  if (dryRun) {
    log(`dry-run: default_mode "${previous}" → "${mode}" em ${join(projectDir, STATE_FILE)}`);
    return { changed: true, previous, mode, dryRun: true };
  }
  await saveProjectState(projectDir, { ...state, default_mode: mode });
  log(`default_mode atualizado: "${previous}" → "${mode}" (${STATE_FILE}).`);
  log("Afeta apenas planos novos — o plano ativo mantém o modo com que foi criado.");
  return { changed: true, previous, mode };
}
