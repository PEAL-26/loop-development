import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig, serializeConfig, mergeManaged, mergeConfigFile, findConfigFile, getPath, removeEntry, removeStaleAgents, computeObsoleteCleanup, removeConfigPaths } from "../src/merge-config.js";

const BASE = {
  agent: {
    "loop-development": {
      permission: {
        task: { "*": "deny", "intake": "allow", "grill-me": "allow" }
      }
    }
  }
};

const BASE_PERM = {
  agent: {
    "loop-development": {
      permission: {
        task: { "*": "deny", "intake": "allow" },
        read: { ".loop-development/**": "allow" },
        edit: { ".loop-development/**": "allow" },
        glob: { ".loop-development/**": "allow" }
      }
    },
    "state-manager": {
      permission: {
        read: { ".loop-development/**": "allow" },
        edit: { ".loop-development/**": "allow" }
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

test("mergeManaged adiciona read/edit/glob no agente e nos subagentes internos", () => {
  const user = {};
  const { config, added } = mergeManaged(user, BASE_PERM);
  const mainRead = getPath(config, "agent.loop-development.permission.read");
  const mainEdit = getPath(config, "agent.loop-development.permission.edit");
  const mainGlob = getPath(config, "agent.loop-development.permission.glob");
  const smRead = getPath(config, "agent.state-manager.permission.read");
  const smEdit = getPath(config, "agent.state-manager.permission.edit");
  assert.equal(mainRead[".loop-development/**"], "allow");
  assert.equal(mainEdit[".loop-development/**"], "allow");
  assert.equal(mainGlob[".loop-development/**"], "allow");
  assert.equal(smRead[".loop-development/**"], "allow");
  assert.equal(smEdit[".loop-development/**"], "allow");
  assert.ok(added.some((a) => a.path === "agent.state-manager.permission.read" && a.key === ".loop-development/**"));
});

test("mergeManaged não sobrescreve valor string existente — envolve como objeto", () => {
  const user = { agent: { "loop-development": { permission: { read: "ask" } } } };
  const { config, added } = mergeManaged(user, BASE_PERM);
  const read = getPath(config, "agent.loop-development.permission.read");
  assert.deepEqual(read, { "*": "ask", ".loop-development/**": "allow" });
  assert.ok(added.some((a) => a.path === "agent.loop-development.permission.read" && a.key === "*"));
});

test("mergeManaged com regras de permissão é idempotente", () => {
  const user = {};
  const first = mergeManaged(user, BASE_PERM);
  const second = mergeManaged(first.config, BASE_PERM);
  assert.equal(second.added.length, 0);
});

test("mergeManaged adiciona o mapa permission.bash global e reporta como added", () => {
  const BASE_BASH = { permission: { bash: { "*": "allow", "git push*": "ask", "rm *": "ask" } } };
  const { config, added, managed } = mergeManaged({}, BASE_BASH);
  const bash = getPath(config, "permission.bash");
  assert.equal(bash["*"], "allow");
  assert.equal(bash["git push*"], "ask");
  assert.equal(bash["rm *"], "ask");
  assert.equal(added.length, 3);
  assert.equal(managed.length, 0);
});

test("mergeManaged é aditivo no permission.bash: não sobrepõe valores existentes", () => {
  const BASE_BASH = { permission: { bash: { "*": "allow", "git push*": "ask", "rm *": "ask" } } };
  const user = { permission: { bash: { "git push*": "deny", "git reset --hard*": "allow" } } };
  const { config, added, managed } = mergeManaged(user, BASE_BASH);
  const bash = getPath(config, "permission.bash");
  assert.equal(bash["git push*"], "deny", "preserva o deny do utilizador");
  assert.equal(bash["git reset --hard*"], "allow", "preserva o allow do utilizador");
  assert.equal(bash["*"], "allow", "adiciona o default em falta");
  assert.equal(bash["rm *"], "ask", "adiciona o padrão em falta");
  assert.equal(managed.length, 0);
});

test("mergeManaged envolve bash string do utilizador e acrescenta padrões aditivos", () => {
  const BASE_BASH = { permission: { bash: { "*": "allow", "git push*": "ask" } } };
  const { config, added } = mergeManaged({ permission: { bash: "ask" } }, BASE_BASH);
  const bash = getPath(config, "permission.bash");
  assert.deepEqual(bash, { "*": "ask", "git push*": "ask" });
  assert.equal(added.length, 2);
});

test("mergeManaged permission.bash é idempotente", () => {
  const BASE_BASH = { permission: { bash: { "*": "allow", "git push*": "ask" } } };
  const first = mergeManaged({}, BASE_BASH);
  const second = mergeManaged(first.config, BASE_BASH);
  assert.equal(second.added.length, 0);
  assert.equal(second.managed.length, 0);
});

test("computeObsoleteCleanup devolve as chaves bash per-agent rastreadas no manifest", () => {
  const manifest = {
    configAdded: [
      { path: "agent.implementer.permission", key: "bash" },
      { path: "agent.verifier.permission", key: "bash" },
      { path: "agent.loop-development.permission.task", key: "intake" }
    ],
    configManaged: []
  };
  assert.deepEqual(computeObsoleteCleanup(manifest).sort(), [
    "agent.implementer.permission.bash",
    "agent.verifier.permission.bash"
  ]);
});

test("computeObsoleteCleanup ignora manifest sem rastreio", () => {
  assert.deepEqual(computeObsoleteCleanup({ configAdded: [] }), []);
  assert.deepEqual(computeObsoleteCleanup(undefined), []);
});

test("removeConfigPaths remove os caminhos presentes e preserva o resto", () => {
  const config = { agent: { implementer: { permission: { bash: "allow", read: { x: "allow" } } } }, outro: 1 };
  const removed = removeConfigPaths(config, ["agent.implementer.permission.bash", "agent.inexistente.permission.bash"]);
  assert.deepEqual(removed, ["agent.implementer.permission.bash"]);
  assert.equal(getPath(config, "agent.implementer.permission.read.x"), "allow");
  assert.equal(config.outro, 1);
});

test("mergeManaged sobrepõe task existente (ask -> allow) e reporta como managed", () => {
  const user = { agent: { "loop-development": { permission: { task: { "*": "ask", "intake": "allow" } } } } };
  const { config, added, managed } = mergeManaged(user, BASE);
  assert.equal(getPath(config, "agent.loop-development.permission.task.*"), "deny");
  assert.equal(added.length, 1);
  assert.equal(managed.length, 1);
  assert.deepEqual(managed[0], { path: "agent.loop-development.permission.task", key: "*", previous: "ask" });
});

test("removeStaleAgents remove entradas stale completas", () => {
  const config = {
    agent: {
      implementer: { name: "implementer", description: "L2", mode: "subagent", prompt: "x", permission: { bash: "ask" } },
      verifier: { name: "verifier", description: "L2", mode: "subagent", prompt: "x", permission: { bash: "ask" } },
      "loop-triage": { name: "loop-triage", description: "x", mode: "primary", prompt: "x", permission: { bash: "ask" } },
      build: { mode: "primary" }
    }
  };
  const removed = removeStaleAgents(config);
  assert.deepEqual(removed.sort(), ["agent.implementer", "agent.loop-triage", "agent.verifier"]);
  assert.deepEqual(Object.keys(config.agent), ["build"]);
});

test("removeStaleAgents não remove entradas geridas (só permission.bash)", () => {
  const config = {
    agent: {
      implementer: { permission: { bash: "allow" } },
      build: { mode: "primary" }
    }
  };
  const removed = removeStaleAgents(config);
  assert.deepEqual(removed, []);
  assert.ok(config.agent.implementer);
});

test("removeStaleAgents é idempotente", () => {
  const config = { agent: { implementer: { name: "implementer", mode: "subagent", prompt: "x" } } };
  const first = removeStaleAgents(config);
  const second = removeStaleAgents(config);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test("mergeConfigFile remove entries stale e regista removed", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ agent: { implementer: { name: "implementer", mode: "subagent", prompt: "x", permission: { bash: "ask" } } } }),
    "utf8"
  );
  const result = await mergeConfigFile(dir, BASE);
  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, ["agent.implementer"]);
  const merged = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(getPath(merged, "agent.implementer"), undefined);
  assert.equal(getPath(merged, "agent.loop-development.permission.task.intake"), "allow");
  assert.ok(existsSync(result.backup));
});

test("mergeConfigFile additiveOnly só acrescenta chaves em falta e preserva as do utilizador", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ agent: { "loop-development": { permission: { read: { "*": "ask" } } } }, custom: 1 }),
    "utf8"
  );
  const base = {
    agent: {
      "loop-development": { permission: { read: { "*": "allow", "*.env": "ask" } } },
      "outro-agente": { permission: { read: { "*": "allow" } } }
    }
  };
  const result = await mergeConfigFile(dir, base, { additiveOnly: true });

  assert.equal(result.changed, true);
  assert.equal(result.managed.length, 0, "additiveOnly nunca rege como managed");
  assert.equal(result.removed.length, 0, "additiveOnly nunca remove");
  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(getPath(config, "agent.loop-development.permission.read.*"), "ask", "regra do utilizador mantida");
  assert.equal(getPath(config, "agent.outro-agente.permission.read.*"), "allow", "chave em falta preenchida");
  assert.equal(config.custom, 1, "resto do config preservado");
  assert.ok(result.added.some((a) => a.path === "agent.outro-agente.permission" && a.key === "read"));
});

test("mergeConfigFile additiveOnly não escreve quando nada falta", async () => {
  const dir = tempDir();
  const before = JSON.stringify({ agent: { "loop-development": { permission: { read: { "*": "allow", "*.env": "deny" } } } } });
  writeFileSync(join(dir, "opencode.json"), before, "utf8");
  const result = await mergeConfigFile(
    dir,
    { agent: { "loop-development": { permission: { read: { "*": "allow" } } } } },
    { additiveOnly: true }
  );
  assert.equal(result.changed, false);
  assert.equal(result.added.length, 0);
  assert.equal(readFileSync(join(dir, "opencode.json"), "utf8"), before);
});

test("mergeConfigFile additiveOnly faz backup do config existente ao alterar", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ custom: 1 }), "utf8");
  const result = await mergeConfigFile(dir, BASE, { additiveOnly: true });
  assert.equal(result.changed, true);
  assert.equal(result.backup, join(dir, "opencode.json.bak-loop-development"));
  assert.ok(existsSync(result.backup));
  assert.deepEqual(JSON.parse(readFileSync(result.backup, "utf8")), { custom: 1 });
});
