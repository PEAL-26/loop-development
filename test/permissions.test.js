import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("opencode.json define o default de shell com padrões destrutivos em ask", async () => {
  const config = JSON.parse(await readFile(join(PKG_ROOT, "opencode", "opencode.json"), "utf8"));
  const bash = config.permission.bash;
  assert.ok(bash, "permission.bash deve existir no top-level");
  const keys = Object.keys(bash);
  assert.equal(keys[0], "*", "o catch-all deve vir primeiro (última regra que casa ganha)");
  assert.equal(bash["*"], "allow", "default de shell é allow");

  const destructive = keys.filter((k) => k !== "*");
  assert.ok(destructive.length >= 30, `lista destrutiva deveria ter ~35 padrões, tem ${destructive.length}`);
  for (const k of destructive) {
    assert.equal(bash[k], "ask", `${k} deve pedir aprovação`);
    assert.match(k, /\*$/, `${k} deve terminar em * para casar com argumentos`);
  }

  const full = destructive.join(" ");
  for (const cmd of ["git push", "git reset --hard", "rm", "sudo", "npm uninstall", "docker rmi", "terraform destroy"]) {
    assert.ok(full.includes(cmd), `a lista deve incluir ${cmd}`);
  }
});

test("os agentes do pacote não declaram bash próprio nos frontmatter", async () => {
  const { readdir } = await import("node:fs/promises");
  const agentsDir = join(PKG_ROOT, "opencode", "agents");
  for (const file of await readdir(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const raw = await readFile(join(agentsDir, file), "utf8");
    assert.ok(!/^  bash:/.test(raw), `${file} não deve ter regra bash no frontmatter (o default global cobre)`);
  }
});
