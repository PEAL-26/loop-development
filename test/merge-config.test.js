import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseConfig,
  serializeConfig,
  normalizeRule,
  ruleKey,
  scopeKey,
  readRules,
  writeRules,
  insertRule,
  removeRule,
  collectManagedRules,
  mergeManaged,
  removeRules,
  migrateV1ToV2,
  orderMigratedRules,
  removeInvalidArtifacts,
  removeStaleAgents,
  computeObsoleteCleanup,
  mergeConfigFile,
  findConfigFile,
  getPath,
  removeEntry
} from "../src/merge-config.js";

// ---------------------------------------------------------------------------
// Bases de teste em forma V2 (arrays ordenados de regras { action, resource,
// effect }). No V2 vale a ÚLTIMA regra que casa, por isso a ordem é parte do
// contrato — o catch-all broad vem sempre antes das excepções específicas.
// ---------------------------------------------------------------------------

const BASE_SHELL = {
  permissions: [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "shell", resource: "git push*", effect: "ask" },
    { action: "shell", resource: "rm *", effect: "ask" }
  ]
};

const BASE_AGENTS = {
  agents: {
    "loop-development": {
      permissions: [
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "subagent", resource: "intake", effect: "allow" },
        { action: "subagent", resource: "grill-me", effect: "allow" },
        { action: "read", resource: ".loop-development/**", effect: "allow" },
        { action: "edit", resource: ".loop-development/**", effect: "allow" },
        { action: "glob", resource: ".loop-development/**", effect: "allow" }
      ]
    },
    "state-manager": {
      permissions: [
        { action: "read", resource: ".loop-development/**", effect: "allow" },
        { action: "edit", resource: ".loop-development/**", effect: "allow" }
      ]
    }
  }
};

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-test-"));
}

// Regras de um scope, já normalizadas — atalho para as asserções.
function rulesOf(config, agent = null) {
  return readRules(config, { agent });
}

function effectOf(config, action, resource, agent = null) {
  return rulesOf(config, agent).find((r) => r.action === action && r.resource === resource)?.effect;
}

// ---------------------------------------------------------------------------
// JSON / JSONC
// ---------------------------------------------------------------------------

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

test("serializeConfig produz JSON válido", () => {
  const text = serializeConfig({ a: 1 });
  assert.equal(JSON.parse(text).a, 1);
});

// ---------------------------------------------------------------------------
// Identidade e normalização de regras
// ---------------------------------------------------------------------------

test("normalizeRule só aceita regras completas e descarta o resto", () => {
  assert.deepEqual(normalizeRule({ action: "read", resource: "*", effect: "allow" }), {
    action: "read",
    resource: "*",
    effect: "allow"
  });
  // Campos em falta ou vazios tornam a regra inutilizável.
  assert.equal(normalizeRule({ action: "read", resource: "*" }), null);
  assert.equal(normalizeRule({ action: "", resource: "*", effect: "allow" }), null);
  assert.equal(normalizeRule({ action: "read", resource: 1, effect: "allow" }), null);
  assert.equal(normalizeRule(["read", "*", "allow"]), null);
  assert.equal(normalizeRule(null), null);
});

test("ruleKey identifica a regra por action+resource e ignora o effect", () => {
  // O effect não entra na identidade: o slot é o que ocupamos e um effect
  // diferente é um conflito reportado, não uma regra nova.
  assert.equal(
    ruleKey({ action: "read", resource: "*", effect: "allow" }),
    ruleKey({ action: "read", resource: "*", effect: "deny" })
  );
  assert.notEqual(
    ruleKey({ action: "read", resource: "*", effect: "allow" }),
    ruleKey({ action: "read", resource: "src/**", effect: "allow" })
  );
  assert.notEqual(
    ruleKey({ action: "read", resource: "*", effect: "allow" }),
    ruleKey({ action: "edit", resource: "*", effect: "allow" })
  );
});

test("scopeKey distingue global de agente", () => {
  assert.equal(scopeKey({ agent: null }), "global");
  assert.equal(scopeKey({ agent: "implementer" }), "agent:implementer");
});

// ---------------------------------------------------------------------------
// Leitura/escrita por scope
// ---------------------------------------------------------------------------

test("readRules lê o scope global e o scope de cada agente", () => {
  const config = {
    permissions: [{ action: "shell", resource: "*", effect: "allow" }],
    agents: { implementer: { permissions: [{ action: "edit", resource: "src/**", effect: "allow" }] } }
  };
  assert.deepEqual(rulesOf(config), [{ action: "shell", resource: "*", effect: "allow" }]);
  assert.deepEqual(rulesOf(config, "implementer"), [{ action: "edit", resource: "src/**", effect: "allow" }]);
  assert.deepEqual(rulesOf(config, "nao-existe"), [], "agente ausente devolve lista vazia");
  assert.deepEqual(readRules(null, { agent: null }), [], "config ausente devolve lista vazia");
  assert.deepEqual(readRules({ permissions: "lixo" }, { agent: null }), [], "valor não-array devolve lista vazia");
});

test("writeRules cria a estrutura do agente e apaga a chave quando a lista esvazia", () => {
  const config = {};
  writeRules(config, { agent: "implementer" }, [{ action: "edit", resource: "*", effect: "allow" }]);
  assert.deepEqual(config.agents.implementer.permissions, [{ action: "edit", resource: "*", effect: "allow" }]);

  writeRules(config, { agent: "implementer" }, []);
  assert.equal(config.agents.implementer.permissions, undefined, "lista vazia apaga a chave");

  writeRules(config, { agent: null }, [{ action: "shell", resource: "*", effect: "allow" }]);
  assert.equal(config.permissions.length, 1);
  writeRules(config, { agent: null }, []);
  assert.equal(config.permissions, undefined, "lista global vazia apaga a chave");
});

// ---------------------------------------------------------------------------
// Política de ordem (o risco de maior impacto da migração)
// ---------------------------------------------------------------------------

test("insertRule coloca o catch-all broad antes das regras específicas da mesma acção", () => {
  const existing = [
    { action: "shell", resource: "git push*", effect: "ask" },
    { action: "read", resource: "src/**", effect: "allow" }
  ];
  const { rules, inserted } = insertRule(existing, { action: "shell", resource: "*", effect: "allow" });
  assert.equal(inserted, true);
  assert.equal(rules[0].resource, "*", "o broad tem de preceder o específico da mesma acção");
  assert.equal(rules[1].resource, "git push*");
  assert.equal(rules[2].resource, "src/**", "regras de outra acção não são reordenadas");
});

test("insertRule deixa o broad depois da última broad da mesma acção", () => {
  const existing = [
    { action: "shell", resource: "git push*", effect: "ask" },
    { action: "shell", resource: "*", effect: "deny" }
  ];
  const { rules } = insertRule(existing, { action: "shell", resource: "*", effect: "allow" });
  // Já existe uma broad com o mesmo action+resource: identidade colide, não
  // inserimos nada em duplicado.
  assert.equal(rules.length, 2);
});

test("insertRule não duplica uma regra já presente e devolve o conflito", () => {
  const existing = [{ action: "shell", resource: "rm *", effect: "deny" }];
  const result = insertRule(existing, { action: "shell", resource: "rm *", effect: "ask" });
  assert.equal(result.inserted, false);
  assert.equal(result.rules.length, 1, "a lista do utilizador fica intacta");
  assert.deepEqual(result.conflict, { action: "shell", resource: "rm *", effect: "deny" });
});

test("insertRule de uma regra específica vai ao fim, onde a prioridade é máxima", () => {
  const existing = [
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" }
  ];
  const { rules } = insertRule(existing, { action: "read", resource: "*.env.*", effect: "ask" });
  assert.equal(rules.at(-1).resource, "*.env.*");
});

test("insertRule não muta a lista original", () => {
  const existing = [{ action: "shell", resource: "*", effect: "allow" }];
  const { rules } = insertRule(existing, { action: "shell", resource: "rm *", effect: "ask" });
  assert.equal(existing.length, 1, "a lista recebida não é tocada");
  assert.equal(rules.length, 2);
});

test("removeRule remove pela identidade e preserva as restantes", () => {
  const existing = [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "shell", resource: "rm *", effect: "ask" }
  ];
  const result = removeRule(existing, { action: "shell", resource: "rm *", effect: "ask" });
  assert.equal(result.removed, true);
  assert.deepEqual(result.rules, [{ action: "shell", resource: "*", effect: "allow" }]);

  const missing = removeRule(existing, { action: "shell", resource: "nada", effect: "ask" });
  assert.equal(missing.removed, false);
  assert.equal(missing.rules.length, 2);
});

test("removeRule remove a regra mesmo com effect diferente, se não houver match exacto", () => {
  const existing = [{ action: "shell", resource: "rm *", effect: "deny" }];
  const result = removeRule(existing, { action: "shell", resource: "rm *", effect: "ask" });
  assert.equal(result.removed, true);
  assert.equal(result.rules.length, 0);
});

// ---------------------------------------------------------------------------
// collectManagedRules
// ---------------------------------------------------------------------------

test("collectManagedRules deriva as regras geridas da config base, global e por agente", () => {
  const managed = collectManagedRules(BASE_AGENTS);
  assert.equal(managed.length, 8, "6 regras do orquestrador + 2 do state-manager");
  assert.ok(managed.every((r) => r.scope.agent !== null), "a base só tem regras por agente");
  assert.ok(managed.some((r) => r.scope.agent === "loop-development" && r.action === "subagent" && r.resource === "intake"));
  assert.ok(managed.some((r) => r.scope.agent === "state-manager" && r.action === "edit"));
  assert.deepEqual(
    collectManagedRules({ permissions: [{ action: "shell", resource: "*", effect: "allow" }] }),
    [{ scope: { agent: null }, action: "shell", resource: "*", effect: "allow" }],
    "as regras de topo entram com scope global"
  );
  assert.deepEqual(collectManagedRules({}), [], "base sem regras não dá nada a gerir");
});

// ---------------------------------------------------------------------------
// mergeManaged — estritamente aditivo (§3.3)
// ---------------------------------------------------------------------------

test("mergeManaged adiciona as regras em falta sem tocar nas existentes", () => {
  const user = { permissions: [{ action: "shell", resource: "git push*", effect: "deny" }] };
  const { config, added } = mergeManaged(user, BASE_SHELL);

  assert.equal(effectOf(config, "shell", "git push*"), "deny", "o deny do utilizador é preservado");
  assert.equal(effectOf(config, "shell", "*"), "allow", "o catch-all em falta é adicionado");
  assert.equal(effectOf(config, "shell", "rm *"), "ask");
  assert.equal(added.length, 2, "só as duas regras que faltavam");
  assert.deepEqual(added[0], { scope: { agent: null }, action: "shell", resource: "*", effect: "allow" });
});

test("mergeManaged cria a estrutura completa se o config não tiver o agente", () => {
  const user = { outro: "valor" };
  const { config, added } = mergeManaged(user, BASE_AGENTS);

  assert.equal(config.outro, "valor", "resto do config preservado");
  assert.equal(config.agents["loop-development"].permissions.length, 6);
  assert.equal(config.agents["state-manager"].permissions.length, 2);
  assert.equal(added.length, 8);
});

test("mergeManaged é idempotente (segunda chamada não adiciona nem conflita)", () => {
  const first = mergeManaged({}, BASE_SHELL);
  const second = mergeManaged(first.config, BASE_SHELL);
  assert.equal(second.added.length, 0);
  assert.equal(second.conflicts.length, 0);
  assert.equal(second.config, first.config, "a config não é reescrita quando nada muda");
});

test("mergeManaged não sobrepõe uma regra do utilizador com effect diferente — reporta conflito", () => {
  // V1 sobrescrevia a chave em silêncio. No V2 sobrescrever significaria remover
  // a regra do utilizador e reinseri-la, o que muda a ordem relativa face às
  // restantes regras dele — por isso ficamos com a dele e reportamos (§3.3).
  const user = { permissions: [{ action: "shell", resource: "*", effect: "deny" }] };
  const { config, added, conflicts } = mergeManaged(user, BASE_SHELL);

  assert.equal(effectOf(config, "shell", "*"), "deny", "a regra do utilizador fica");
  assert.deepEqual(conflicts, [{ scope: { agent: null }, action: "shell", resource: "*", kept: "deny", ours: "allow" }]);
  assert.deepEqual(
    added.map((a) => a.resource).sort(),
    ["git push*", "rm *"],
    "as regras que não colidem são sempre adicionadas"
  );
});

test("mergeManaged mantém a ordem broad-antes-de-específico ao juntar as regras da base", () => {
  const { config } = mergeManaged({}, BASE_SHELL);
  assert.deepEqual(
    rulesOf(config).map((r) => `${r.resource}:${r.effect}`),
    ["*:allow", "git push*:ask", "rm *:ask"],
    "a ordem relativa das regras geridas é preservada"
  );
});

test("mergeManaged não reordena as regras já existentes do utilizador", () => {
  const user = {
    permissions: [
      { action: "shell", resource: "rm *", effect: "deny" },
      { action: "shell", resource: "git push*", effect: "ask" }
    ]
  };
  const { config, added } = mergeManaged(user, BASE_SHELL);
  // O broad entra antes das específicas da acção (§3.2), o que desloca as duas
  // regras do utilizador uma casa — mas a ordem relativa entre elas mantém-se, e
  // nenhuma é reordenada em relação à outra.
  assert.deepEqual(
    rulesOf(config).slice(1).map((r) => r.resource),
    ["rm *", "git push*"],
    "as duas regras do utilizador mantêm a ordem relativa entre si"
  );
  assert.equal(rulesOf(config)[0].resource, "*", "o broad entra antes das específicas da acção");
  assert.deepEqual(added.map((a) => a.resource), ["*"], "só o catch-all faltava; as outras duas colidem com as do utilizador");
});

test("mergeManaged deteta conflito no scope de um agente sem tocar no global", () => {
  const user = { agents: { "state-manager": { permissions: [{ action: "edit", resource: ".loop-development/**", effect: "deny" }] } } };
  const { config, conflicts } = mergeManaged(user, BASE_AGENTS);
  assert.equal(effectOf(config, "edit", ".loop-development/**", "state-manager"), "deny");
  assert.equal(effectOf(config, "read", ".loop-development/**", "state-manager"), "allow", "a outra regra do agente entra");
  assert.deepEqual(conflicts, [
    {
      scope: { agent: "state-manager" },
      action: "edit",
      resource: ".loop-development/**",
      kept: "deny",
      ours: "allow"
    }
  ]);
});

// ---------------------------------------------------------------------------
// Migração V1 → V2
// ---------------------------------------------------------------------------

test("migrateV1ToV2 converte agent→agents e mapas permission→arrays, com renomeações", () => {
  const config = {
    permission: {
      bash: { "*": "allow", "git push*": "ask" },
      task: { "*": "deny", intake: "allow" },
      write: { "src/**": "allow" },
      patch: { "docs/**": "ask" }
    },
    agent: {
      "loop-development": { prompt: "sou eu", disable: false, permission: { bash: { "*": "allow" } } }
    }
  };

  const { config: out, migrated, report } = migrateV1ToV2(config);

  assert.equal(migrated, true);
  assert.equal(out.agent, undefined, '"agent" foi removido');
  assert.equal(out.permission, undefined, '"permission" foi removido');

  const global = out.permissions;
  assert.equal(global[0].resource, "*", "o broad vem primeiro (a ordem V1 era significant)");
  assert.ok(global.some((r) => r.action === "shell" && r.resource === "git push*" && r.effect === "ask"));
  assert.ok(global.some((r) => r.action === "subagent" && r.resource === "intake" && r.effect === "allow"));
  assert.ok(global.some((r) => r.action === "edit" && r.resource === "src/**" && r.effect === "allow"), "write→edit");
  assert.ok(global.some((r) => r.action === "edit" && r.resource === "docs/**" && r.effect === "ask"), "patch→edit");

  const agent = out.agents["loop-development"];
  assert.equal(agent.prompt, undefined);
  assert.equal(agent.system, "sou eu", "prompt→system");
  assert.equal(agent.disable, undefined);
  assert.equal(agent.disabled, false, "disable→disabled");
  assert.deepEqual(agent.permissions, [{ action: "shell", resource: "*", effect: "allow" }]);

  assert.ok(report.some((r) => r.includes('"agent" → "agents"')));
  assert.ok(report.some((r) => r.includes('"permission" → "permissions"')));
});

test("migrateV1ToV2 preserva o que não sabe converter e reporta-o", () => {
  // Um effect que não é string não dá para virar regra V2: em vez de o perder,
  // fica no mapa `permission` para o doctor o apontar.
  const config = { permission: { bash: { "*": "allow" }, Customizar: { "*": 1 } } };
  const { config: out, report } = migrateV1ToV2(config);
  assert.deepEqual(out.permission, { "Customizar.*": { "*": 1 } }, "o que não converte é preservado como estava");
  assert.ok(report.some((r) => r.includes("Customizar.*") && r.includes("doctor")));
  assert.equal(out.permissions.length, 1, "a parte migrável continua a ser aplicada");
});

test("migrateV1ToV2 não pisa um agente que já exista em agents", () => {
  const { config: out, report } = migrateV1ToV2({
    agent: { implementer: { prompt: "antigo" } },
    agents: { implementer: { system: "novo" } }
  });
  assert.deepEqual(out.agents.implementer, { system: "novo" });
  assert.ok(report.some((r) => r.includes("já existia")));
});

test("migrateV1ToV2 é idempotente", () => {
  const first = migrateV1ToV2({ permission: { bash: { "*": "allow", "rm *": "ask" } } });
  const second = migrateV1ToV2(first.config);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.config.permissions, first.config.permissions);
});

test("migrateV1ToV2 com um valor string converte para o catch-all", () => {
  const { config } = migrateV1ToV2({ permission: { bash: "ask" } });
  assert.deepEqual(config.permissions, [{ action: "shell", resource: "*", effect: "ask" }]);
});

test("orderMigratedRules põe todos os broad à frente dos específicos", () => {
  const ordered = orderMigratedRules([
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*", effect: "allow" }
  ]);
  assert.deepEqual(ordered.map((r) => r.resource), ["*", "*.env"]);
});

test("removeInvalidArtifacts apaga o agents.permission herdado do installer V1", () => {
  const config = { agents: { permission: { bash: "allow" }, implementer: { system: "x" } } };
  assert.deepEqual(removeInvalidArtifacts(config), ["agents.permission"]);
  assert.deepEqual(Object.keys(config.agents), ["implementer"]);
  assert.deepEqual(removeInvalidArtifacts({ agents: {} }), []);
});

// ---------------------------------------------------------------------------
// Limpeza de regras obsoletas
// ---------------------------------------------------------------------------

test("computeObsoleteCleanup devolve as regras shell per-agent rastreadas no manifest v2", () => {
  const manifest = {
    configAdded: [
      { legacy: false, agent: "implementer", action: "shell", resource: "*", effect: "allow" },
      { legacy: false, agent: "verifier", action: "shell", resource: "*", effect: "allow" },
      { legacy: false, agent: "implementer", action: "read", resource: "x", effect: "allow" },
      { legacy: false, agent: "grill-me", action: "shell", resource: "*", effect: "allow" }
    ],
    configManaged: []
  };
  assert.deepEqual(computeObsoleteCleanup(manifest), [
    { agent: "implementer", action: "shell", resource: "*", effect: "allow" },
    { agent: "verifier", action: "shell", resource: "*", effect: "allow" }
  ]);
});

test("computeObsoleteCleanup ignora entradas v1 (não casam com regras V2)", () => {
  const manifest = {
    configAdded: [{ path: "agent.implementer.permission", key: "bash" }],
    configManaged: [{ path: "agent.verifier.permission", key: "bash" }]
  };
  assert.deepEqual(computeObsoleteCleanup(manifest), [], "entradas legacy não correspondem a nenhuma regra V2");
  assert.deepEqual(computeObsoleteCleanup({ configAdded: [] }), []);
  assert.deepEqual(computeObsoleteCleanup(undefined), []);
});

test("removeRules remove as regras presentes e preserva o resto", () => {
  const config = {
    permissions: [{ action: "shell", resource: "*", effect: "allow" }],
    agents: {
      implementer: {
        permissions: [
          { action: "shell", resource: "*", effect: "allow" },
          { action: "read", resource: "x", effect: "allow" }
        ]
      }
    },
    outro: 1
  };
  const removed = removeRules(config, [
    { agent: "implementer", action: "shell", resource: "*", effect: "allow" },
    { agent: "nao-existe", action: "shell", resource: "*", effect: "allow" }
  ]);

  assert.deepEqual(removed, [{ scope: { agent: "implementer" }, action: "shell", resource: "*", effect: "allow" }]);
  assert.deepEqual(rulesOf(config, "implementer"), [{ action: "read", resource: "x", effect: "allow" }]);
  assert.equal(effectOf(config, "shell", "*"), "allow", "as regras globais não são tocadas");
  assert.equal(config.outro, 1);
});

// ---------------------------------------------------------------------------
// removeEntry / removeStaleAgents
// ---------------------------------------------------------------------------

test("removeEntry remove a chave e poda contentores vazios", () => {
  const config = { agents: { "loop-development": { permissions: [{ action: "subagent", resource: "intake", effect: "allow" }] } } };
  removeEntry(config, "agents.loop-development.permissions", "0");
  assert.deepEqual(config, {});
});

test("removeEntry mantém contentores não vazios", () => {
  const config = {
    agents: { "loop-development": { permissions: [{ action: "subagent", resource: "intake", effect: "allow" }] } },
    outro: true
  };
  removeEntry(config, "agents", "loop-development");
  assert.equal(config.agents, undefined);
  assert.equal(config.outro, true);
});

test("removeStaleAgents remove entradas stale completas", () => {
  const config = {
    agents: {
      implementer: { name: "implementer", description: "L2", mode: "subagent", prompt: "x", permission: { bash: "ask" } },
      verifier: { name: "verifier", description: "L2", mode: "subagent", prompt: "x", permission: { bash: "ask" } },
      "loop-triage": { name: "loop-triage", description: "x", mode: "primary", prompt: "x", permission: { bash: "ask" } },
      build: { mode: "primary" }
    }
  };
  const removed = removeStaleAgents(config);
  assert.deepEqual(removed.sort(), ["agents.implementer", "agents.loop-triage", "agents.verifier"]);
  assert.deepEqual(Object.keys(config.agents), ["build"]);
});

test("removeStaleAgents não remove entradas geridas (só permissões)", () => {
  const config = {
    agents: {
      implementer: { permissions: [{ action: "shell", resource: "*", effect: "allow" }] },
      build: { mode: "primary" }
    }
  };
  assert.deepEqual(removeStaleAgents(config), []);
  assert.ok(config.agents.implementer);
});

test("removeStaleAgents é idempotente", () => {
  const config = { agents: { implementer: { name: "implementer", mode: "subagent", prompt: "x" } } };
  assert.equal(removeStaleAgents(config).length, 1);
  assert.equal(removeStaleAgents(config).length, 0);
});

// ---------------------------------------------------------------------------
// mergeConfigFile (disco)
// ---------------------------------------------------------------------------

test("mergeConfigFile cria opencode.json e faz backup quando já existe", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { key: "x" } }), "utf8");

  const result = await mergeConfigFile(dir, BASE_SHELL);

  assert.equal(result.changed, true);
  assert.equal(result.backup, join(dir, "opencode.json.bak-loop-development"));
  const merged = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(merged.provider.key, "x");
  assert.equal(merged.permissions.length, 3);
  assert.deepEqual(JSON.parse(readFileSync(result.backup, "utf8")), { provider: { key: "x" } });
});

test("mergeConfigFile é idempotente em disco", async () => {
  const dir = tempDir();
  await mergeConfigFile(dir, BASE_SHELL);
  const afterFirst = readFileSync(join(dir, "opencode.json"), "utf8");
  const result = await mergeConfigFile(dir, BASE_SHELL);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(join(dir, "opencode.json"), "utf8"), afterFirst);
});

test("mergeConfigFile suporta opencode.jsonc", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.jsonc"), "{ // config\n \"a\": 1 }\n", "utf8");
  await mergeConfigFile(dir, BASE_SHELL);
  assert.equal(findConfigFile(dir).endsWith("opencode.jsonc"), true);
  const config = parseConfig(readFileSync(join(dir, "opencode.jsonc"), "utf8"));
  assert.equal(config.a, 1);
  assert.equal(effectOf(config, "shell", "rm *"), "ask");
});

test("mergeConfigFile em modo managed migra o config V1 do utilizador e reporta", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ permission: { bash: { "*": "allow", "rm *": "ask" } } }), "utf8");

  const result = await mergeConfigFile(dir, BASE_SHELL);

  assert.equal(result.changed, true);
  assert.ok(result.report.some((r) => r.includes('"permission" → "permissions"')));
  const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(config.permission, undefined, "o mapa V1 desapareceu");
  assert.equal(effectOf(config, "shell", "rm *"), "ask", "a regra migrada do utilizador foi preservada");
});

test("mergeConfigFile remove entradas stale e regista removed", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ agents: { implementer: { name: "implementer", mode: "subagent", prompt: "x" } } }),
    "utf8"
  );

  const result = await mergeConfigFile(dir, BASE_AGENTS);

  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, ["agents.implementer"]);
  const merged = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(getPath(merged, "agents.implementer"), undefined);
  assert.equal(effectOf(merged, "subagent", "intake", "loop-development"), "allow");
  assert.ok(existsSync(result.backup));
});

test("mergeConfigFile remove as regras obsoletas que recebe", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ agents: { implementer: { permissions: [{ action: "shell", resource: "*", effect: "allow" }] } } }),
    "utf8"
  );

  const result = await mergeConfigFile(dir, BASE_SHELL, {
    removeRules: [{ agent: "implementer", action: "shell", resource: "*", effect: "allow" }]
  });

  assert.deepEqual(result.removed, ["agent:implementer:shell|*"]);
  const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(getPath(config, "agents.implementer.permissions"), undefined);
});

test("mergeConfigFile em modo managed reporta os conflitos sem tocar na regra do utilizador", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ permissions: [{ action: "shell", resource: "*", effect: "deny" }] }), "utf8");

  const result = await mergeConfigFile(dir, BASE_SHELL);

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kept, "deny");
  const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(effectOf(config, "shell", "*"), "deny");
});

test("mergeConfigFile em modo managed faz backup ao migrar o config V1 do utilizador", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ permission: { bash: { "rm *": "ask" } }, custom: 1 }), "utf8");
  const result = await mergeConfigFile(dir, BASE_SHELL);
  assert.equal(result.changed, true);
  assert.ok(existsSync(result.backup));
  assert.deepEqual(JSON.parse(readFileSync(result.backup, "utf8")), { permission: { bash: { "rm *": "ask" } }, custom: 1 });
  const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(config.custom, 1, "o resto do config sobrevive à migração");
});

// --- modo project (grants de acesso, aditivos, sem migração) ----------------

test("mergeConfigFile em modo project só acrescenta regras em falta e preserva as do utilizador", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agents: { implementer: { permissions: [{ action: "read", resource: "*", effect: "ask" }] } }, custom: 1 }), "utf8");

  const base = {
    agents: {
      implementer: { permissions: [{ action: "read", resource: "*", effect: "allow" }, { action: "read", resource: "*.env", effect: "ask" }] },
      "outro-agente": { permissions: [{ action: "read", resource: "*", effect: "allow" }] }
    }
  };

  const result = await mergeConfigFile(dir, base, { mode: "project" });

  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, [], "o modo project nunca remove");
  const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(effectOf(config, "read", "*", "implementer"), "ask", "regra do utilizador mantida");
  assert.equal(effectOf(config, "read", "*.env", "implementer"), "ask", "regra do utilizador mantida");
  assert.equal(effectOf(config, "read", "*", "outro-agente"), "allow", "regra em falta preenchida");
  assert.equal(config.custom, 1, "resto do config preservado");
  assert.equal(result.conflicts.length, 1, "o '*' allow do implementer colide com o ask do utilizador");
});

// Migra também o config do projeto. Sem isso, um `permission` em forma V1 fica
// ilegível para o V2 e os nossos grants entrariam como se o utilizador não tivesse
// dito nada: um `ask` dele seria silenciosamente Allow.
test("mergeConfigFile em modo project preserva a intenção do utilizador ao migrar o V1", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ agent: { intake: { permission: { read: { "*": "ask" } } } } }),
    "utf8",
  );
  const base = { agents: { intake: { permissions: [{ action: "read", resource: "*", effect: "allow" }] } } };

  const result = await mergeConfigFile(dir, base, { mode: "project" });

  const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(config.agent, undefined, "`agent` migrado para `agents`");
  assert.equal(
    effectOf(config, "read", "*", "intake"),
    "ask",
    "o ask do utilizador prevalece — os nossos grants não o enfraquecem",
  );
  assert.ok(
    result.conflicts.some((c) => c.action === "read" && c.resource === "*" && c.kept === "ask"),
    "o conflito é reportado ao utilizador em vez de ser resolvido em silêncio",
  );
});

test("mergeConfigFile em modo project não traz os grants de shell do config global", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ permission: { bash: { "*": "ask" } } }), "utf8");
  const base = { agents: { intake: { permissions: [{ action: "read", resource: "*", effect: "allow" }] } } };

  await mergeConfigFile(dir, base, { mode: "project" });

  const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  // O `bash: { "*": "ask" }` do utilizador migra para uma regra shell sua — não
  // são os grants globais do pacote (os 35 padrões destrutivos) a entrar aqui.
  assert.equal(config.permission, undefined, "a chave V1 `permission` desapareceu");
  assert.deepEqual(
    config.permissions,
    [{ action: "shell", resource: "*", effect: "ask" }],
    "apenas a regra do utilizador, já convertida",
  );
  assert.equal(effectOf(config, "read", "*", "intake"), "allow", "os grants de acesso ao projeto são aplicados");
});

test("mergeConfigFile em modo project não escreve quando nada falta", async () => {
  const dir = tempDir();
  const before = JSON.stringify({ agents: { "loop-development": { permissions: [{ action: "read", resource: "*", effect: "allow" }, { action: "read", resource: "*.env", effect: "deny" }] } } });
  writeFileSync(join(dir, "opencode.json"), before, "utf8");

  const result = await mergeConfigFile(
    dir,
    { agents: { "loop-development": { permissions: [{ action: "read", resource: "*", effect: "allow" }] } } },
    { mode: "project" }
  );

  assert.equal(result.changed, false);
  assert.equal(result.added.length, 0);
  assert.equal(readFileSync(join(dir, "opencode.json"), "utf8"), before);
});

test("mergeConfigFile em modo project faz backup do config existente ao alterar", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ custom: 1 }), "utf8");
  const result = await mergeConfigFile(dir, BASE_SHELL, { mode: "project" });
  assert.equal(result.changed, true);
  assert.equal(result.backup, join(dir, "opencode.json.bak-loop-development"));
  assert.ok(existsSync(result.backup));
  assert.deepEqual(JSON.parse(readFileSync(result.backup, "utf8")), { custom: 1 });
});

test("mergeConfigFile com dryRun não escreve", async () => {
  const dir = tempDir();
  const result = await mergeConfigFile(dir, BASE_SHELL, { dryRun: true });
  assert.equal(result.changed, true);
  assert.equal(existsSync(findConfigFile(dir)), false);
});