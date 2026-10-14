import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RULES_START,
  RULES_END,
  AGENTS_FILE,
  buildRulesBlock,
  findRulesBlock,
  upsertRulesBlock,
  removeRulesBlock,
  hasRulesBlock,
  linkRules,
  unlinkRules,
  rulesStatus,
  buildProjectRulesBlock,
  checkPresetModules,
} from "../src/rules.js";
import { skillDir, SKILL_NAME } from "../src/skills.js";
import { presetRules, BACKEND_PRESETS, FRONTEND_PRESETS } from "../src/presets.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-rules-"));
}

function fixtureSkill(configDir) {
  const location = skillDir(configDir, SKILL_NAME);
  mkdirSync(join(location, "references", "general"), { recursive: true });
  mkdirSync(join(location, "references", "backend"), { recursive: true });
  writeFileSync(join(location, "SKILL.md"), "x", "utf8");
  writeFileSync(join(location, "references", "general", "security.md"), "# 5 pilares", "utf8");
  writeFileSync(join(location, "references", "general", "git-workflow.md"), "# commits", "utf8");
  writeFileSync(join(location, "references", "backend", "nestjs.md"), "# nestjs", "utf8");
  writeFileSync(join(location, "references", "backend", "prisma.md"), "# prisma", "utf8");
  return location;
}

const SAMPLE = buildRulesBlock({
  skillPath: "~/.config/opencode/skills/project-rules",
  alwaysOn: ["references/general/security.md"],
  modules: ["references/backend/nestjs.md"],
  installed: true,
});

// ---------------------------------------------------------------------------
// Construção do bloco
// ---------------------------------------------------------------------------

test("buildRulesBlock declara raiz, universais, projecto e precedência", () => {
  const block = buildRulesBlock({
    skillPath: "~/.config/opencode/skills/project-rules",
    alwaysOn: ["references/general/security.md", "references/general/git-workflow.md"],
    modules: ["references/backend/nestjs.md"],
    installed: true,
  });
  assert.ok(block.startsWith(RULES_START));
  assert.ok(block.endsWith(RULES_END));
  assert.match(block, /## Regras da casa — `project-rules`/);
  assert.match(block, /`~\/\.config\/opencode\/skills\/project-rules`/);
  assert.match(block, /loop-development skills path/);
  assert.match(block, /references\/general\/security\.md/);
  assert.match(block, /references\/backend\/nestjs\.md/);
  assert.match(block, /este AGENTS\.md prevalece sobre a skill/);
  assert.doesNotMatch(block, /ainda não está instalada/);
});

test("buildRulesBlock avisa quando a skill não está instalada", () => {
  const block = buildRulesBlock({ installed: false });
  assert.match(block, /ainda não está instalada/);
  assert.match(block, /loop-development skills ensure/);
  assert.match(block, /`~\/\.config\/opencode\/skills\/project-rules`/, "mesmo sem instalar, o path canónico é o mesmo");
});

test("buildRulesBlock sem módulos do projecto diz isso explicitamente", () => {
  const block = buildRulesBlock({ alwaysOn: [], modules: [] });
  assert.match(block, /nenhum módulo específico/);
});

// ---------------------------------------------------------------------------
// Manipulação do ficheiro
// ---------------------------------------------------------------------------

test("findRulesBlock devolve null sem marcadores ou com marcadores órfãos", () => {
  assert.equal(findRulesBlock("# AGENTS.md\n"), null);
  assert.equal(findRulesBlock(`${RULES_START}\nsem fim`), null);
  assert.notEqual(findRulesBlock(`antes\n${SAMPLE}\ndepois`), null);
});

test("upsertRulesBlock num ficheiro novo faz append", () => {
  const result = upsertRulesBlock("# AGENTS.md\n\n- regra minha\n", SAMPLE);
  assert.equal(result.action, "appended");
  assert.match(result.content, /^# AGENTS\.md/);
  assert.ok(result.content.indexOf("- regra minha") < result.content.indexOf(RULES_START));
});

test("upsertRulesBlock substitui só o bloco, mantendo o resto byte a byte", () => {
  const before = "# AGENTS.md\n\n- regra minha\n";
  const first = upsertRulesBlock(before, SAMPLE);
  const updated = buildRulesBlock({ alwaysOn: ["references/general/security.md"], modules: [], installed: true });
  const second = upsertRulesBlock(first.content, updated);

  assert.equal(second.action, "replaced");
  assert.ok(second.content.startsWith(before), "o que vem antes do bloco não mexeu");
  assert.ok(second.content.trimEnd().endsWith(RULES_END));
  assert.doesNotMatch(second.content, /references\/backend\/nestjs\.md/, "o bloco novo substituiu o antigo");
});

test("upsertRulesBlock é idempotente", () => {
  const first = upsertRulesBlock("", SAMPLE);
  const second = upsertRulesBlock(first.content, SAMPLE);
  assert.equal(second.action, "unchanged");
  assert.equal(second.content, first.content);
});

test("upsertRulesBlock num ficheiro vazio escreve só o bloco", () => {
  const result = upsertRulesBlock("", SAMPLE);
  assert.equal(result.action, "appended");
  assert.ok(result.content.startsWith(RULES_START));
});

test("removeRulesBlock apaga o bloco e limpa o separador", () => {
  const content = upsertRulesBlock("# AGENTS.md\n\n- regra minha\n", SAMPLE).content;
  const result = removeRulesBlock(content);
  assert.equal(result.changed, true);
  assert.equal(result.content, "# AGENTS.md\n\n- regra minha\n");
  assert.equal(hasRulesBlock(result.content), false);
});

test("removeRulesBlock é seguro sem bloco e com ficheiro só com bloco", () => {
  assert.equal(removeRulesBlock("sem nada").changed, false);
  assert.equal(removeRulesBlock(SAMPLE).content, "");
});

test("um bloco nunca é duplicado por link repetido", () => {
  let content = upsertRulesBlock("# AGENTS.md\n", SAMPLE).content;
  content = upsertRulesBlock(content, SAMPLE).content;
  assert.equal(content.split(RULES_START).length - 1, 1);
  assert.equal(content.split(RULES_END).length - 1, 1);
});

// ---------------------------------------------------------------------------
// Comandos sobre disco
// ---------------------------------------------------------------------------

test("linkRules insere o bloco num AGENTS.md do utilizador e é idempotente", async () => {
  const configDir = tempDir();
  const projectDir = tempDir();
  fixtureSkill(configDir);
  writeFileSync(join(projectDir, AGENTS_FILE), "# As minhas\n\n- código em inglês\n", "utf8");

  const first = await linkRules({ projectDir, configDir, log: () => {} });
  assert.equal(first.action, "appended");
  assert.equal(first.installed, true);
  const content = readFileSync(join(projectDir, AGENTS_FILE), "utf8");
  assert.match(content, /- código em inglês/, "o conteúdo do utilizador sobrevive");
  assert.ok(hasRulesBlock(content));
  assert.match(content, /references\/general\/security\.md/);

  const second = await linkRules({ projectDir, configDir, log: () => {} });
  assert.equal(second.action, "unchanged");
  assert.equal(readFileSync(join(projectDir, AGENTS_FILE), "utf8"), content);
});

test("linkRules num projecto sem AGENTS.md cria-o", async () => {
  const configDir = tempDir();
  const projectDir = tempDir();
  fixtureSkill(configDir);

  const result = await linkRules({ projectDir, configDir, log: () => {} });
  assert.equal(result.action, "appended");
  assert.ok(hasRulesBlock(readFileSync(join(projectDir, AGENTS_FILE), "utf8")));
});

test("linkRules reporta os módulos pedidos que não existem na skill", async () => {
  const configDir = tempDir();
  const projectDir = tempDir();
  fixtureSkill(configDir);

  const lines = [];
  const result = await linkRules({
    projectDir,
    configDir,
    modules: ["backend/nestjs", "backend/drizzle-inexistente"],
    log: (m) => lines.push(m),
  });
  assert.deepEqual(result.missing, ["backend/drizzle-inexistente"]);
  assert.ok(lines.some((l) => l.includes("backend/drizzle-inexistente")));
  const content = readFileSync(join(projectDir, AGENTS_FILE), "utf8");
  assert.match(content, /references\/backend\/nestjs\.md/);
  assert.doesNotMatch(content, /drizzle-inexistente/, "o módulo inexistente não entra no bloco");
});

test("linkRules em dry-run não escreve", async () => {
  const configDir = tempDir();
  const projectDir = tempDir();
  fixtureSkill(configDir);
  await linkRules({ projectDir, configDir, dryRun: true, log: () => {} });
  assert.equal(existsSync(join(projectDir, AGENTS_FILE)), false);
});

test("unlinkRules remove o bloco e preserva o resto", async () => {
  const configDir = tempDir();
  const projectDir = tempDir();
  fixtureSkill(configDir);
  writeFileSync(join(projectDir, AGENTS_FILE), "# As minhas\n", "utf8");
  await linkRules({ projectDir, configDir, log: () => {} });

  const result = await unlinkRules({ projectDir, log: () => {} });
  assert.equal(result.changed, true);
  assert.equal(readFileSync(join(projectDir, AGENTS_FILE), "utf8"), "# As minhas\n");

  assert.equal((await unlinkRules({ projectDir, log: () => {} })).changed, false);
});

test("unlinkRules num projecto sem AGENTS.md não explode", async () => {
  assert.equal((await unlinkRules({ projectDir: tempDir(), log: () => {} })).changed, false);
});

test("rulesStatus distingue bloco presente, ausente e skill ausente", async () => {
  const configDir = tempDir();
  const projectDir = tempDir();
  fixtureSkill(configDir);
  writeFileSync(join(projectDir, AGENTS_FILE), "# As minhas\n", "utf8");

  const semBloco = await rulesStatus({ projectDir, configDir, log: () => {} });
  assert.equal(semBloco.linked, false);
  assert.equal(semBloco.skillInstalled, true);

  await linkRules({ projectDir, configDir, log: () => {} });
  const comBloco = await rulesStatus({ projectDir, configDir, log: () => {} });
  assert.equal(comBloco.linked, true);

  // O bloco em disco descreve o estado no momento em que foi escrito; o status
  // reporta o estado de agora. São coisas diferentes e ambas úteis.
  const lines = [];
  const semSkill = await rulesStatus({ projectDir, configDir: tempDir(), log: (m) => lines.push(m) });
  assert.equal(semSkill.skillInstalled, false);
  assert.ok(lines.some((l) => l.includes("não instalada")));

  const semFicheiro = await rulesStatus({ projectDir: tempDir(), configDir, log: () => {} });
  assert.equal(semFicheiro.linked, false);
});

// ---------------------------------------------------------------------------
// Integração com os presets
// ---------------------------------------------------------------------------

test("presetRules traduz a stack escolhida em módulos da skill", () => {
  assert.deepEqual(presetRules("nestjs-prisma", null), ["backend/nestjs", "backend/prisma"]);
  assert.deepEqual(presetRules("nestjs-supabase", null), ["backend/nestjs", "backend/supabase"]);
  assert.deepEqual(presetRules(null, "expo"), ["frontend/expo-mobile", "frontend/components", "frontend/forms"]);
  // backend + frontend: união sem repetir `components`/`forms`.
  assert.deepEqual(presetRules("express", "vite"), ["backend/express-fastify", "frontend/vite-spa", "frontend/components", "frontend/forms"]);
  assert.deepEqual(presetRules(null, null), []);
});

test("buildProjectRulesBlock junta universais e do projecto sem duplicar", async () => {
  const configDir = tempDir();
  fixtureSkill(configDir);

  const built = await buildProjectRulesBlock({ configDir, modules: presetRules("nestjs-prisma") });
  assert.deepEqual(built.alwaysOn, ["references/general/git-workflow.md", "references/general/security.md"]);
  assert.deepEqual(built.presetModules, ["references/backend/nestjs.md", "references/backend/prisma.md"]);
  assert.deepEqual(built.missing, []);
  assert.ok(built.location != null);
  assert.match(built.block, /references\/backend\/prisma\.md/);
});

test("buildProjectRulesBlock sem skill instalada não inventa módulos", async () => {
  const built = await buildProjectRulesBlock({ configDir: tempDir(), modules: presetRules("nestjs-prisma") });
  assert.equal(built.location, null);
  assert.deepEqual(built.alwaysOn, []);
  assert.deepEqual(built.presetModules, []);
  assert.deepEqual(built.missing, ["backend/nestjs", "backend/prisma"]);
  assert.match(built.block, /nenhum módulo específico/);
});

// ---------------------------------------------------------------------------
// Divergência entre os presets e a skill publicada
// ---------------------------------------------------------------------------

test("checkPresetModules passa quando a skill tem tudo o que os presets pedem", async () => {
  const configDir = tempDir();
  // A fixture espelha os nomes que os presets esperam.
  const location = skillDir(configDir, SKILL_NAME);
  mkdirSync(join(location, "references", "general"), { recursive: true });
  mkdirSync(join(location, "references", "backend"), { recursive: true });
  mkdirSync(join(location, "references", "frontend"), { recursive: true });
  writeFileSync(join(location, "SKILL.md"), "x", "utf8");
  const modules = [
    ...presetRules("nestjs-prisma"), ...presetRules("nestjs-supabase"), ...presetRules("express"),
    ...presetRules("fastify"), ...presetRules("next"), ...presetRules("vite"), ...presetRules("expo"),
    ...BACKEND_PRESETS.flatMap((p) => p.rules), ...FRONTEND_PRESETS.flatMap((p) => p.rules),
  ];
  for (const spec of new Set(modules)) {
    writeFileSync(join(location, "references", `${spec}.md`), "x", "utf8");
  }

  const lines = [];
  const result = await checkPresetModules({ configDir, log: (m) => lines.push(m) });
  assert.equal(result.ok, true, `módulos em falta: ${result.missing.map((x) => x.module).join(", ")}`);
  assert.ok(lines.some((l) => l.startsWith("OK")));
});

test("checkPresetModules apanha módulos que a skill já não tem", async () => {
  const configDir = tempDir();
  const location = skillDir(configDir, SKILL_NAME);
  mkdirSync(join(location, "references", "backend"), { recursive: true });
  writeFileSync(join(location, "SKILL.md"), "x", "utf8");
  // Só existe `nestjs`; `prisma` foi renomeado no repo da skill.
  writeFileSync(join(location, "references", "backend", "nestjs.md"), "x", "utf8");

  const lines = [];
  const result = await checkPresetModules({ configDir, log: (m) => lines.push(m) });
  assert.equal(result.ok, false);
  assert.equal(result.installed, true);
  assert.ok(result.missing.some((x) => x.module === "backend/prisma"));
  assert.ok(result.missing.some((x) => x.preset === "nestjs-prisma"));
  assert.ok(lines.some((l) => l.includes("skills update")));
});

test("checkPresetModules diz o que fazer quando a skill não está instalada", async () => {
  const lines = [];
  const result = await checkPresetModules({ configDir: tempDir(), log: (m) => lines.push(m) });
  assert.equal(result.ok, false);
  assert.equal(result.installed, false);
  assert.ok(lines.some((l) => l.includes("skills ensure")));
});
