import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig, serializeConfig, mergeManaged, mergeConfigFile, findConfigFile, getPath, removeEntry } from "../src/merge-config.js";

const BASE = {
  agent: {
    "loop-development": {
      permission: {
        task: { "*": "deny", "intake": "allow", "grill-me": "allow" }
      }
    }
  }
};

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-test-"));
}

test("parseConfig aceita JSONC (comentários de linha e vírgulas finais)", () => {
  const config = parseConfig(`{
    // comentário
    "a": 1,
    "b": { "c": 2, },
  }`);
  assert.deepEqual(config, { a: 1, b: { c: 2 } });
});

test("parseConfig não corrompe URLs dentro de strings", () => {
  const config = parseConfig(`{
    "url": "https://opencode.ai/config.json",
    "repo": "https://github.com/x/y"
  }`);
  assert.equal(config.url, "https://opencode.ai/config.json");
  assert.equal(config.repo, "https://github.com/x/y");
});

test("mergeManaged adiciona permissões ausentes sem tocar nas existentes", () => {
  const user = { agent: { "loop-development": { permission: { task: { "*": "deny", "intake": "allow" } } } } };
  const { config, added } = mergeManaged(user, BASE);
  assert.equal(config.agent["loop-development"].permission.task["grill-me"], "allow");
  assert.equal(config.agent["loop-development"].permission.task["intake"], "allow");
  assert.equal(config.agent["loop-development"].permission.task["*"], "deny");
  assert.equal(added.length, 1);
  assert.deepEqual(added[0], { path: "agent.loop-development.permission.task", key: "grill-me" });
});

test("mergeManaged cria a estrutura completa se o config não tiver o agente", () => {
  const user = { other: "valor" };
  const { config, added } = mergeManaged(user, BASE);
  assert.deepEqual(config.agent["loop-development"].permission.task, { "*": "deny", "intake": "allow", "grill-me": "allow" });
  assert.equal(added.length, 3);
  assert.equal(config.other, "valor");
});

test("mergeManaged é idempotente (segunda chamada não adiciona nada)", () => {
  const user = {};
  const first = mergeManaged(user, BASE);
  const second = mergeManaged(first.config, BASE);
  assert.equal(second.added.length, 0);
  assert.equal(second.config, first.config);
});

test("mergeConfigFile cria opencode.json e faz backup quando já existe", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { key: "x" } }), "utf8");
  const result = await mergeConfigFile(dir, BASE);
  assert.equal(result.changed, true);
  assert.equal(result.backup, join(dir, "opencode.json.bak-loop-development"));
  const merged = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(merged.provider.key, "x");
  assert.equal(merged.agent["loop-development"].permission.task["intake"], "allow");
  const backup = JSON.parse(readFileSync(result.backup, "utf8"));
  assert.deepEqual(backup, { provider: { key: "x" } });
});

test("mergeConfigFile é idempotente em disco", async () => {
  const dir = tempDir();
  await mergeConfigFile(dir, BASE);
  const afterFirst = readFileSync(join(dir, "opencode.json"), "utf8");
  const result = await mergeConfigFile(dir, BASE);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(join(dir, "opencode.json"), "utf8"), afterFirst);
});

test("mergeConfigFile suporta opencode.jsonc", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.jsonc"), "{ // config\n \"a\": 1 }\n", "utf8");
  await mergeConfigFile(dir, BASE);
  assert.equal(findConfigFile(dir).endsWith("opencode.jsonc"), true);
  const config = parseConfig(readFileSync(join(dir, "opencode.jsonc"), "utf8"));
  assert.equal(config.a, 1);
  assert.equal(getPath(config, "agent.loop-development.permission.task.intake"), "allow");
});

test("removeEntry remove a chave e poda contentores vazios", () => {
  const config = { agent: { "loop-development": { permission: { task: { "intake": "allow" } } } } };
  removeEntry(config, "agent.loop-development.permission.task", "intake");
  assert.deepEqual(config, {});
});

test("removeEntry mantém contentores não vazios", () => {
  const config = { agent: { "loop-development": { permission: { task: { "intake": "allow", "verifier": "allow" } } } }, outro: true };
  removeEntry(config, "agent.loop-development.permission.task", "intake");
  assert.equal(getPath(config, "agent.loop-development.permission.task.verifier"), "allow");
  assert.equal(config.outro, true);
});

test("serializeConfig produz JSON válido", () => {
  const text = serializeConfig({ a: 1 });
  assert.equal(JSON.parse(text).a, 1);
});
