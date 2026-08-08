import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installGlobal, installProject } from "../src/install.js";
import { uninstall } from "../src/uninstall.js";
import { setModel } from "../src/set-model.js";
import { loadManifest, MANIFEST_FILE } from "../src/manifest.js";
import { findConfigFile, parseConfig, getPath } from "../src/merge-config.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-install-"));
}

test("installGlobal copia assets, mescla config e grava manifesto", async () => {
  const dir = tempDir();
  await installGlobal({ configDir: dir });

  assert.ok(existsSync(join(dir, "agents", "loop-development.md")));
  assert.ok(existsSync(join(dir, "agents", "intake.md")));
  assert.ok(existsSync(join(dir, "commands", "loop-development.md")));
  assert.ok(existsSync(join(dir, "commands", "loop-development-continue.md")));
  assert.ok(existsSync(join(dir, "commands", "loop-development-status.md")));
  assert.ok(existsSync(join(dir, "templates", "AGENTS.md.template")));
  assert.ok(existsSync(join(dir, "templates", ".loop-development", "state.json")));
  assert.ok(existsSync(join(dir, "scripts", "set-model.sh")));

  const configFile = findConfigFile(dir);
  assert.ok(existsSync(configFile));
  const config = parseConfig(readFileSync(configFile, "utf8"));
  assert.equal(getPath(config, "agent.loop-development.permission.task.intake"), "allow");
  assert.equal(getPath(config, "agent.loop-development.permission.task.grill-me"), "allow");
  assert.equal(getPath(config, "agent.loop-development.permission.task.*"), "deny");

  const mainRead = getPath(config, "agent.loop-development.permission.read");
  assert.equal(mainRead[".loop-development/**"], "allow");
  assert.equal(getPath(config, "agent.loop-development.permission.edit")[".loop-development/**"], "allow");
  assert.equal(getPath(config, "agent.loop-development.permission.glob")[".loop-development/**"], "allow");
  assert.equal(getPath(config, "agent.state-manager.permission.read")[".loop-development/**"], "allow");
  assert.equal(getPath(config, "agent.context-loader.permission.edit")[".loop-development/**"], "allow");

  for (const name of ["implementer", "test-writer", "git-manager"]) {
    assert.equal(getPath(config, `agent.${name}.permission.read`)[".loop-development/**"], "allow", `${name} deve ler .loop-development/**`);
    assert.equal(getPath(config, `agent.${name}.permission.glob`)[".loop-development/**"], "allow", `${name} deve fazer glob de .loop-development/**`);
    assert.equal(getPath(config, `agent.${name}.permission.edit`), undefined, `${name} não deve ter edit allow em .loop-development/**`);
  }

  for (const name of ["implementer", "refactorer", "test-writer", "verifier", "dependency-auditor", "security-auditor", "performance-auditor"]) {
    assert.equal(getPath(config, `agent.${name}.permission.bash`), "allow", `${name} deve ter bash allow`);
  }

  const manifest = await loadManifest(dir);
  assert.ok(manifest.files.length > 0);
  assert.ok(manifest.configAdded.length > 0);
  assert.ok(manifest.version);
});

test("installGlobal é idempotente", async () => {
  const dir = tempDir();
  await installGlobal({ configDir: dir });
  const first = await loadManifest(dir);
  const result = await installGlobal({ configDir: dir });
  const second = await loadManifest(dir);
  assert.equal(result.copied, 0);
  assert.equal(result.merged, false);
  assert.equal(second.files.length, first.files.length);
  assert.equal(second.configAdded.length, first.configAdded.length);
});

test("installGlobal preserva arquivos e config pré-existentes do usuário", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "meu-agente.md"), "---\ndescription: meu\nmode: subagent\n---\ncorpo", "utf8");
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { chave: "valor" } }), "utf8");

  await installGlobal({ configDir: dir });

  assert.equal(readFileSync(join(dir, "agents", "meu-agente.md"), "utf8").includes("meu"), true);
  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(config.provider.chave, "valor");
  assert.equal(getPath(config, "agent.loop-development.permission.task.intake"), "allow");
});

test("installGlobal --force sobrescreve arquivos existentes", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "intake.md"), "conteúdo antigo", "utf8");
  await installGlobal({ configDir: dir, force: true });
  assert.match(readFileSync(join(dir, "agents", "intake.md"), "utf8"), /Intake/);
});

test("installGlobal --dry-run não escreve nada", async () => {
  const dir = tempDir();
  const result = await installGlobal({ configDir: dir, dryRun: true });
  assert.ok(result.copied > 0, "dry-run deve reportar o que seria copiado");
  assert.ok(!existsSync(join(dir, "agents")));
  assert.ok(!existsSync(join(dir, MANIFEST_FILE)));
  assert.ok(!existsSync(join(dir, "opencode.json")));
});

test("installGlobal remove entries stale do config e registra configRemoved", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ agent: { implementer: { name: "implementer", description: "L2", mode: "subagent", prompt: "x", permission: { bash: "ask" } } } }),
    "utf8"
  );

  const result = await installGlobal({ configDir: dir });

  assert.ok(result.configRemoved.includes("agent.implementer"));
  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(getPath(config, "agent.implementer.name"), undefined);
  assert.equal(getPath(config, "agent.implementer.permission.bash"), "allow");
  const manifest = await loadManifest(dir);
  assert.ok(manifest.configRemoved.includes("agent.implementer"));
  assert.ok(existsSync(join(dir, "opencode.json.bak-loop-development")));
});

test("installGlobal com entry stale é idempotente", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ agent: { implementer: { name: "implementer", mode: "subagent", prompt: "x", permission: { bash: "ask" } } } }),
    "utf8"
  );
  await installGlobal({ configDir: dir });
  const result = await installGlobal({ configDir: dir });
  assert.equal(result.merged, false);
  assert.equal(result.configRemoved.length, 0);
});

test("uninstall remove só o que foi instalado e preserva o resto", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "meu-agente.md"), "---\ndescription: meu\nmode: subagent\n---\ncorpo", "utf8");

  await installGlobal({ configDir: dir });
  await uninstall({ configDir: dir });

  assert.ok(!existsSync(join(dir, "agents", "loop-development.md")));
  assert.ok(!existsSync(join(dir, "commands", "loop-development.md")));
  assert.ok(!existsSync(join(dir, "templates", "AGENTS.md.template")));
  assert.ok(!existsSync(join(dir, "scripts", "set-model.sh")));
  assert.ok(existsSync(join(dir, "agents", "meu-agente.md")));

  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(getPath(config, "agent.loop-development"), undefined);
  assert.ok(!existsSync(join(dir, MANIFEST_FILE)));
});

test("setModel altera os agentes instalados do tier", async () => {
  const dir = tempDir();
  await installGlobal({ configDir: dir });
  const changed = await setModel("mechanical", "opencode/gpt-5-nano", { configDir: dir });
  assert.ok(changed > 0);
  const intake = readFileSync(join(dir, "agents", "intake.md"), "utf8");
  assert.match(intake, /^model: opencode\/gpt-5-nano$/m);
});

test("setModel rejeita tier inválido", async () => {
  await assert.rejects(() => setModel("inexistente", "x/y", { configDir: tempDir() }), /Tier inválido/);
});

test("installProject cria .loop-development/ e AGENTS.md", async () => {
  const dir = tempDir();
  await installProject({ targetDir: dir });
  assert.ok(existsSync(join(dir, ".loop-development", "state.json")));
  assert.ok(existsSync(join(dir, "AGENTS.md")));
  assert.ok(!existsSync(join(dir, "AGENTS.md.template")));
});

test("installProject é idempotente", async () => {
  const dir = tempDir();
  await installProject({ targetDir: dir });
  const result = await installProject({ targetDir: dir });
  assert.equal(result.copied, 0);
  assert.equal(result.existed > 0, true);
});

test("installProject com presets gera AGENTS.md preenchido", async () => {
  const dir = tempDir();
  const result = await installProject({ targetDir: dir, backend: "nestjs-prisma", frontend: "expo", pm: "pnpm" });
  assert.equal(result.presets, true);
  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.match(agents, /## Stack/);
  assert.match(agents, /## Comandos do projeto/);
  assert.match(agents, /NestJS 11 \(Express\) \+ Prisma 7/);
  assert.match(agents, /Expo SDK 55/);
  assert.match(agents, /- Dev \(backend\): pnpm start:dev/);
  assert.ok(existsSync(join(dir, ".loop-development", "state.json")));
  assert.ok(!existsSync(join(dir, "AGENTS.md.template")));
});

test("installProject rejeita preset desconhecido", async () => {
  await assert.rejects(() => installProject({ targetDir: tempDir(), backend: "x" }), /Preset de backend desconhecido: x/);
});
