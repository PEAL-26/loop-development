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
