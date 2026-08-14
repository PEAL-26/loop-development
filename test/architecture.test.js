import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeArchitecture, checkArchitecture, REQUIRED_SECTIONS, CONTENT_SIGNALS } from "../src/architecture.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-arch-"));
}

const LEAN = `# Arquitetura

> Decisões de arquitetura validadas pelo Architecture Reviewer.

## Stack

NestJS 11

## Padrões adotados

Clean Architecture

## Estrutura de pastas

- src/

## Decisões relevantes

Usamos PostgreSQL.
`;

const BLOATED = [
  "# Arquitetura",
  "",
  "> Decisões de arquitetura validadas pelo Architecture Reviewer.",
  "",
  "## Stack",
  "",
  "NestJS 11 + Prisma 7",
  "",
  "## Padrões adotados",
  "",
  "Clean Architecture",
  "",
  "## Estrutura de pastas",
  "",
  "- src/",
  "",
  "## Decisões relevantes",
  "",
  "Fase do projeto: alpha (MVP).",
  "As funções usadas no dashboard são getUsers e getMetrics.",
  "Migração M001: CREATE TABLE users (id serial);",
  "Ver plans/20260808.2246-login-google para detalhes.",
  "- [x] tarefa concluída",
  "",
  "```",
  "const sql = \"SELECT * FROM users\";",
  "```"
].join("\n");

test("sinais e seções obrigatórias estão exportados", () => {
  assert.deepEqual(REQUIRED_SECTIONS, ["Stack", "Padrões adotados", "Estrutura de pastas", "Decisões relevantes"]);
  assert.ok(Array.isArray(CONTENT_SIGNALS) && CONTENT_SIGNALS.length >= 10);
  for (const s of CONTENT_SIGNALS) {
    assert.ok(typeof s.name === "string" && s.name.length > 0);
    assert.ok(s.pattern instanceof RegExp, `sinal "${s.name}" sem regex`);
  }
});

test("arquitetura lean não gera violações nem avisos", () => {
  const { violations, warnings } = analyzeArchitecture(LEAN);
  assert.deepEqual(violations, []);
  assert.deepEqual(warnings, []);
});

test("arquitetura inchada gera violações com linha e sinal", () => {
  const { violations, warnings } = analyzeArchitecture(BLOATED);
  assert.deepEqual(warnings, []);

  const bySignal = (name) => violations.filter((v) => v.signal === name).map((v) => v.line);
  assert.deepEqual(bySignal("fase do projeto"), [19]);
  assert.deepEqual(bySignal("menção a MVP"), [19]);
  assert.deepEqual(bySignal("migração de tarefa"), [21]);
  assert.ok(bySignal("script SQL").includes(21));
  assert.ok(bySignal("script SQL").includes(26));
  assert.deepEqual(bySignal("referência a planos"), [22]);
  assert.deepEqual(bySignal("id de tarefa (M0xx)"), [21]);
  assert.deepEqual(bySignal("id de plano (timestamp)"), [22]);
  assert.deepEqual(bySignal("lista de tarefas/checklist"), [23]);
  assert.deepEqual(bySignal("bloco de código"), [25, 27]);

  for (const v of violations) {
    assert.ok(v.line >= 1 && v.snippet.length > 0);
  }
});

test("seções obrigatórias em falta geram aviso não-bloqueante", () => {
  const doc = "# Arquitetura\n\n## Stack\n\n## Estrutura de pastas\n";
  const { violations, warnings } = analyzeArchitecture(doc);
  assert.deepEqual(violations, []);
  assert.deepEqual(warnings.map((w) => w.section), ["Padrões adotados", "Decisões relevantes"]);
});

test("checkArchitecture lê o ficheiro do projeto e reporta", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, ".loop-development"), { recursive: true });
  writeFileSync(join(dir, ".loop-development", "architecture.md"), BLOATED, "utf8");

  const logs = [];
  const result = await checkArchitecture({ targetDir: dir, log: (s) => logs.push(s) });

  assert.equal(result.missing, false);
  assert.ok(result.violations.length > 0);
  assert.match(logs.join("\n"), /Violações de conteúdo: \d+/);
});

test("checkArchitecture sem ficheiro reporta missing sem violações", async () => {
  const dir = tempDir();
  const logs = [];
  const result = await checkArchitecture({ targetDir: dir, log: (s) => logs.push(s) });
  assert.equal(result.missing, true);
  assert.deepEqual(result.violations, []);
});
