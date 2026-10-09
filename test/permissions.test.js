import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

// No V2 as permissões são uma lista ordenada de `{ action, resource, effect }`
// no array `permissions` de topo, e vale a ÚLTIMA regra que casa. Os padrões
// destrutivos têm por isso de vir DEPOIS do catch-all allow.
test("opencode.json define o default de shell com padrões destrutivos em ask", async () => {
  const config = JSON.parse(await readFile(join(PKG_ROOT, "opencode", "opencode.json"), "utf8"));
  const permissions = config.permissions;
  assert.ok(Array.isArray(permissions), "permissions deve ser um array no top-level");
  assert.equal(config.permission, undefined, "o mapa V1 permission.bash não deve existir");
  assert.equal(config.agent, undefined, 'o mapa V1 "agent" não deve existir');

  const shell = permissions.filter((r) => r?.action === "shell");
  assert.ok(shell.length > 0, "deve haver regras action: \"shell\"");
  for (const rule of permissions) {
    assert.equal(typeof rule.action, "string");
    assert.equal(typeof rule.resource, "string");
    assert.equal(typeof rule.effect, "string");
  }

  assert.equal(shell[0].resource, "*", "o catch-all deve vir primeiro (última regra que casa ganha)");
  assert.equal(shell[0].effect, "allow", "default de shell é allow");

  const destructive = shell.slice(1);
  assert.ok(destructive.length >= 30, `lista destrutiva deveria ter ~35 padrões, tem ${destructive.length}`);
  for (const rule of destructive) {
    assert.equal(rule.effect, "ask", `${rule.resource} deve pedir aprovação`);
    assert.match(rule.resource, /\*$/, `${rule.resource} deve terminar em * para casar com argumentos`);
  }

  const full = destructive.map((r) => r.resource).join(" ");
  for (const cmd of ["git push", "git reset --hard", "rm", "sudo", "npm uninstall", "docker rmi", "terraform destroy"]) {
    assert.ok(full.includes(cmd), `a lista deve incluir ${cmd}`);
  }
});

test("os agentes do pacote não declaram shell próprio nos frontmatter", async () => {
  const { readdir } = await import("node:fs/promises");
  const agentsDir = join(PKG_ROOT, "opencode", "agents");
  for (const file of await readdir(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const raw = await readFile(join(agentsDir, file), "utf8");
    // §3.6: o .md é a única fonte das permissões internas dos nossos agentes. A
    // acção chama-se `shell` no V2 — `bash` no frontmatter seria a forma V1.
    assert.ok(!/^  bash:/.test(raw), `${file} não deve ter regra bash no frontmatter (o default global cobre)`);
  }
});
