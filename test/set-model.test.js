import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceModelForTier } from "../src/set-model.js";

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
