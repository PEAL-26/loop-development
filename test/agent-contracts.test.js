import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function readAgent(name) {
  return readFile(join(PKG_ROOT, "opencode", "agents", `${name}.md`), "utf8");
}

test("grill-me define entrevista iterativa e estados explícitos", async () => {
  const content = await readAgent("grill-me");

  assert.match(content, /exatamente uma pergunta/);
  assert.match(content, /não faças uma segunda pergunta na mesma invocação/);
  assert.match(content, /needs_research/);
  assert.match(content, /resolved/);
  assert.match(content, /blocked/);
  assert.match(content, /não escolhas .* sem pesquisa/i);
  assert.match(content, /contradisser uma decisão anterior/);
  assert.match(content, /falta de informação|sem informação nova/i);
});

test("orquestrador não pede aprovação redundante das tarefas", async () => {
  const content = await readAgent("loop-development");

  assert.match(content, /Aprovação automática das tarefas/);
  assert.match(content, /tasks_approval_source: "plan-approval"/);
  assert.match(content, /Não peças uma segunda aprovação/);
  assert.match(content, /alteração de escopo ou decisão nova/);
  assert.doesNotMatch(content, /PARAGEM OBRIGATÓRIA — Aprovação das tarefas/);
});

test("researcher e planner não assumem decisões relevantes", async () => {
  const researcher = await readAgent("researcher");
  const planner = await readAgent("planner");

  assert.match(researcher, /alternativas comparáveis/);
  assert.match(researcher, /Não escolhas/);
  assert.match(planner, /Não assumes decisões relevantes/);
  assert.match(planner, /clarifications\.md/);
});
