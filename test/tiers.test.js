import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "opencode", "agents");

const EXPECTED_TIERS = {
  reasoning: ["loop-development", "grill-me", "researcher", "planner", "architecture-reviewer", "security-auditor", "performance-auditor", "final-reviewer"],
  coding: ["implementer", "refactorer", "test-writer", "task-generator"],
  docs: ["planner-writer", "documentation-writer"],
  mechanical: ["intake", "dependency-auditor", "context-loader", "verifier", "git-manager", "state-manager", "compacter"]
};

test("cada agente tem exatamente um tier conhecido", () => {
  for (const name of readdirSync(AGENTS_DIR)) {
    if (!name.endsWith(".md")) continue;
    const content = readFileSync(join(AGENTS_DIR, name), "utf8");
    const match = content.match(/^# tier: (\w+)$/m);
    assert.ok(match, `${name} deve ter "# tier: <tier>" no frontmatter`);
    assert.ok(Object.keys(EXPECTED_TIERS).includes(match[1]), `${name} tem tier desconhecido "${match[1]}"`);
  }
});

test("a lista de agentes por tier corresponde à tabela do README", () => {
  const files = readdirSync(AGENTS_DIR)
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.replace(/\.md$/, ""));

  const expected = new Set(Object.values(EXPECTED_TIERS).flat());
  assert.deepEqual([...expected].sort(), [...files].sort(), "todo agente está mapeado numa tier e vice-versa");
});

test("todos os agentes de um tier partilham o mesmo modelo", () => {
  const byTier = {};
  for (const [tier, agents] of Object.entries(EXPECTED_TIERS)) {
    const models = agents.map((a) => {
      const content = readFileSync(join(AGENTS_DIR, `${a}.md`), "utf8");
      const match = content.match(/^model: (.+)$/m);
      assert.ok(match, `${a}.md deve ter "model:"`);
      return match[1].trim();
    });
    byTier[tier] = new Set(models);
    assert.equal(byTier[tier].size, 1, `tier "${tier}" deve ter um modelo único por todos os agentes`);
  }
});
