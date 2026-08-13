import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODELS, replaceModelForTier, setModels } from "../src/set-model.js";

const AGENT = `---
description: Exemplo
mode: subagent
model: opencode/deepseek-v4-flash-free
# tier: mechanical
temperature: 0.1
permission:
  edit: allow
  bash: deny
---

# Corpo
`;

test("substitui o modelo de um agente do tier correspondente", () => {
  const out = replaceModelForTier(AGENT, "mechanical", "opencode/gpt-4o-free");
  assert.match(out, /^model: opencode\/gpt-4o-free$/m);
  assert.doesNotMatch(out, /opencode\/deepseek-v4-flash-free/);
  assert.match(out, /# Corpo/);
});

test("não altera agentes de outro tier", () => {
  const out = replaceModelForTier(AGENT, "reasoning", "anthropic/claude-opus-4-8");
  assert.equal(out, AGENT);
});

test("não altera conteúdo sem frontmatter", () => {
  const out = replaceModelForTier("sem frontmatter\nmodel: x", "mechanical", "y");
  assert.equal(out, "sem frontmatter\nmodel: x");
});

function createConfig(agents) {
  const configDir = mkdtempSync(join(tmpdir(), "loop-development-models-"));
  const agentsDir = join(configDir, "agents");
  mkdirSync(agentsDir);
  for (const [name, tier, model = "provider/old"] of agents) {
    writeFileSync(join(agentsDir, `${name}.md`), `---\nmodel: ${model}\n# tier: ${tier}\n---\n`, "utf8");
  }
  return configDir;
}

test("atualiza vários tiers numa única operação", async () => {
  const configDir = createConfig([
    ["reasoning-agent", "reasoning"],
    ["coding-agent", "coding"],
    ["docs-agent", "docs"]
  ]);

  const changed = await setModels({ reasoning: "provider/reasoning", coding: "provider/coding" }, { configDir, check: false });

  assert.equal(changed, 2);
  assert.match(readFileSync(join(configDir, "agents", "reasoning-agent.md"), "utf8"), /^model: provider\/reasoning$/m);
  assert.match(readFileSync(join(configDir, "agents", "coding-agent.md"), "utf8"), /^model: provider\/coding$/m);
  assert.match(readFileSync(join(configDir, "agents", "docs-agent.md"), "utf8"), /^model: provider\/old$/m);
});

test("restaura todos os defaults e é idempotente", async () => {
  const configDir = createConfig([
    ["reasoning-agent", "reasoning", "provider/custom"],
    ["coding-agent", "coding", "provider/custom"],
    ["docs-agent", "docs", "provider/custom"],
    ["mechanical-agent", "mechanical", "provider/custom"]
  ]);

  const changed = await setModels(DEFAULT_MODELS, { configDir, check: false });
  const unchanged = await setModels(DEFAULT_MODELS, { configDir, check: false });

  assert.equal(changed, 4);
  assert.equal(unchanged, 0);
  for (const [tier, model] of Object.entries(DEFAULT_MODELS)) {
    const content = readFileSync(join(configDir, "agents", `${tier}-agent.md`), "utf8");
    assert.match(content, new RegExp(`^model: ${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
});

test("valida todos os tiers antes de escrever", async () => {
  const configDir = createConfig([["coding-agent", "coding", "provider/old"]]);

  await assert.rejects(
    () => setModels({ coding: "provider/new", docs: "provider/docs" }, { configDir, check: false }),
    /Nenhum agente com tier "docs"/
  );
  assert.match(readFileSync(join(configDir, "agents", "coding-agent.md"), "utf8"), /^model: provider\/old$/m);
});

test("rejeita modelos vazios ou sem provider antes de escrever", async () => {
  const configDir = createConfig([["coding-agent", "coding", "provider/old"]]);

  await assert.rejects(() => setModels({ coding: "invalid" }, { configDir, check: false }), /Modelo inválido/);
  assert.match(readFileSync(join(configDir, "agents", "coding-agent.md"), "utf8"), /^model: provider\/old$/m);
});
