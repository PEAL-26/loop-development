import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { displayPath, skillRootForProject, expandModules, DEFAULT_ALWAYS_ON, SKILL_NAME } from "./skills.js";
import { BACKEND_PRESETS, FRONTEND_PRESETS } from "./presets.js";

// ---------------------------------------------------------------------------
// Bloco "Regras da casa" do AGENTS.md.
//
// O AGENTS.md de um projecto guarda o DELTA (stack, comandos reais, estrutura,
// "nunca fazer" específico) e declara que herda o resto da skill global. O bloco
// é delimitado por marcadores para que possa ser reescrito sem tocar no resto
// do ficheiro — o AGENTS.md é versionado e escrito à mão.
// ---------------------------------------------------------------------------

export const RULES_START = "<!-- loop-development:rules:start -->";
export const RULES_END = "<!-- loop-development:rules:end -->";

export const AGENTS_FILE = "AGENTS.md";

function list(items) {
  // Indentado para aninhar sob a alínea que o introduz.
  return items.map((m) => `  - \`${m}\``).join("\n");
}

export function buildRulesBlock({
  skillName = SKILL_NAME,
  skillPath = null,
  alwaysOn = DEFAULT_ALWAYS_ON,
  modules = [],
  installed = false,
} = {}) {
  const lines = [];
  lines.push(RULES_START);
  lines.push(`## Regras da casa — \`${skillName}\``);
  lines.push("");
  lines.push(
    `Este projecto herda as regras de engenharia da skill \`${skillName}\`, instalada globalmente.`,
    "**Não as reescrevas aqui**: o AGENTS.md guarda apenas o delta do projecto (stack, comandos, estrutura).",
    "",
  );

  lines.push(`- **Raiz da skill:** \`${skillPath ?? "~/.config/opencode/skills/" + skillName}\``);
  lines.push("  (se usaste outro config-dir, resolve com `loop-development skills path`)");
  lines.push("");

  if (alwaysOn.length > 0) {
    lines.push(
      `- **Sempre aplicáveis** (carregar em qualquer tarefa que toque código):`,
      "",
      list(alwaysOn),
      "",
    );
  }

  if (modules.length > 0) {
    lines.push(`- **Este projecto** (carregar antes de escrever código):`, "", list(modules), "");
  } else {
    lines.push("- **Este projecto**: nenhum módulo específico — aplica apenas as regras universais.", "");
  }

  if (!installed) {
    lines.push(
      "> A skill ainda não está instalada nesta máquina. Corre `loop-development skills ensure`",
      "> para a trazer; até lá, aplica as regras acima pela tua conhecimento e pelo AGENTS.md.",
      "",
    );
  }

  lines.push(
    "- **Precedência:** em caso de conflito, este AGENTS.md prevalece sobre a skill;",
    "  a skill prevalece sobre o conhecimento geral do modelo.",
  );
  lines.push(RULES_END);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Manipulação do ficheiro (puro — testável sem disco)
// ---------------------------------------------------------------------------

export function findRulesBlock(content) {
  const start = content.indexOf(RULES_START);
  if (start === -1) return null;
  const end = content.indexOf(RULES_END, start);
  if (end === -1) return null;
  return { start, end: end + RULES_END.length, body: content.slice(start, end + RULES_END.length) };
}

// Substitui o bloco se existir; senão faz append. Devolve sempre conteúdo com
// exactamente um bloco, seja qual for o estado de partida.
export function upsertRulesBlock(content, block) {
  const current = content ?? "";
  const found = findRulesBlock(current);
  if (found) {
    if (found.body === block) return { content: current, action: "unchanged" };
    return { content: current.slice(0, found.start) + block + current.slice(found.end), action: "replaced" };
  }
  const base = current.trim();
  const head = base === "" ? "" : `${base}\n\n`;
  return { content: `${head}${block}\n`, action: "appended" };
}

export function removeRulesBlock(content) {
  const current = content ?? "";
  const found = findRulesBlock(current);
  if (!found) return { content: current, changed: false };
  // Limpa o bloco em branco que a remoção deixa para trás.
  const rest = (current.slice(0, found.start) + current.slice(found.end)).replace(/\n{3,}/g, "\n\n").trimEnd();
  return { content: rest === "" ? "" : `${rest}\n`, changed: true };
}

export function hasRulesBlock(content) {
  return findRulesBlock(content ?? "") != null;
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

function unique(items) {
  return [...new Set(items)];
}

// Monta o bloco a partir do que existe: módulos da skill instalada + os módulos
// que os presets do projecto pedem. Módulos inexistentes são omitidos com aviso.
export async function buildProjectRulesBlock({ configDir, modules = [] } = {}) {
  const location = await skillRootForProject({ configDir });
  const { modules: alwaysOn } = await expandModules(location ?? "", location ? DEFAULT_ALWAYS_ON : []);
  const { modules: presetModules, missing } = await expandModules(location ?? "", modules);
  return {
    block: buildRulesBlock({
      skillPath: location ? displayPath(location) : null,
      alwaysOn,
      modules: unique(presetModules),
      installed: location != null,
    }),
    location,
    alwaysOn,
    presetModules,
    missing,
  };
}

export async function linkRules({ projectDir = process.cwd(), configDir = null, modules = [], dryRun = false, log = () => {} } = {}) {
  const file = join(projectDir, AGENTS_FILE);
  const built = await buildProjectRulesBlock({ configDir, modules });
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  const result = upsertRulesBlock(current, built.block);

  if (result.action === "unchanged") {
    log(`${AGENTS_FILE}: bloco de regras da casa já está em dia`);
    return { file, action: "unchanged", installed: built.location != null, missing: built.missing };
  }
  if (!dryRun) await writeFile(file, result.content, "utf8");
  log(
    `${AGENTS_FILE}: bloco de regras ${result.action === "replaced" ? "actualizado" : "inserido"}` +
      (built.location ? "" : " (a skill ainda não está instalada)"),
  );
  if (built.missing.length > 0) {
    log(`  aviso: módulos pedidos que não existem na skill: ${built.missing.join(", ")}`);
  }
  return { file, action: result.action, installed: built.location != null, missing: built.missing };
}

export async function unlinkRules({ projectDir = process.cwd(), dryRun = false, log = () => {} } = {}) {
  const file = join(projectDir, AGENTS_FILE);
  if (!existsSync(file)) {
    log(`${AGENTS_FILE}: não existe em ${projectDir}`);
    return { file, changed: false };
  }
  const result = removeRulesBlock(await readFile(file, "utf8"));
  if (!result.changed) {
    log(`${AGENTS_FILE}: sem bloco de regras da casa`);
    return { file, changed: false };
  }
  if (!dryRun) await writeFile(file, result.content, "utf8");
  log(`${AGENTS_FILE}: bloco de regras ${dryRun ? "(dry-run) removido" : "removido"}`);
  return { file, changed: true };
}

export async function rulesStatus({ projectDir = process.cwd(), configDir = null, log = () => {} } = {}) {
  const file = join(projectDir, AGENTS_FILE);
  const location = await skillRootForProject({ configDir });
  if (!existsSync(file)) {
    log(`${AGENTS_FILE}: não existe em ${projectDir}`);
    return { file, linked: false, skillInstalled: location != null };
  }
  const found = findRulesBlock(await readFile(file, "utf8"));
  log(`${AGENTS_FILE}: ${found ? "com bloco de regras da casa" : "sem bloco de regras da casa"}`);
  log(`  skill: ${location ? `instalada em ${displayPath(location)}` : "não instalada (corre 'loop-development skills ensure')"}`);
  if (!found) log("  liga com 'loop-development rules link'");
  return { file, linked: found != null, skillInstalled: location != null, body: found?.body ?? null };
}

// Confere, contra a skill **instalada**, que cada preset pede módulos que
// existem de facto. É a rede de segurança para a divergência entre os dois
// repositórios: sem isto, renomear um módulo no repo da skill faria um projecto
// ficar com regras silenciosamente incompletas.
//
// Não toca na rede e não assume nenhum checkout local — a fonte de verdade é a
// cópia instalada em `<configDir>/skills/`.
export async function checkPresetModules({ configDir = null, log = () => {} } = {}) {
  const location = await skillRootForProject({ configDir });
  if (!location) {
    log("a skill project-rules não está instalada — 'loop-development skills ensure' primeiro");
    return { ok: false, installed: false, missing: [] };
  }

  const missing = [];
  for (const preset of [...BACKEND_PRESETS, ...FRONTEND_PRESETS]) {
    const result = await expandModules(location, preset.rules ?? []);
    for (const spec of result.missing) missing.push({ preset: preset.id, module: spec });
  }

  if (missing.length === 0) {
    log(`OK   Todos os módulos pedidos pelos presets existem na skill instalada (${[...BACKEND_PRESETS, ...FRONTEND_PRESETS].length} presets)`);
    return { ok: true, installed: true, missing: [] };
  }

  log(`${missing.length} módulo(s) pedido(s) por presets que não existem na skill instalada:`);
  for (const { preset, module } of missing) log(`  - ${preset}: ${module}`);
  log("Ou renomeaste o módulo no repo da skill, ou o preset aponta para um nome antigo. Actualiza com 'loop-development skills update'.");
  return { ok: false, installed: true, missing };
}
