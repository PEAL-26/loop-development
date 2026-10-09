import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  normalizeExternalPath,
  toExternalPatterns,
  toPosix,
  loadAllowedFolders,
  addAllowedFolder,
  removeAllowedFolder,
  clearAllowedFolders,
  listAllowedFolders,
  writeExternalDirectory,
  extendLoopDevPatterns,
  shrinkLoopDevPatterns,
  allowedFoldersPath,
  INTERNAL_STATE_AGENTS,
  addExternalDirectoryPatterns,
  removeExternalDirectoryPatterns
} from "../src/access.js";
import { findConfigFile, parseConfig, readRules } from "../src/merge-config.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-access-"));
}

function readConfig(dir) {
  const file = findConfigFile(dir);
  return existsSync(file) ? parseConfig(readFileSync(file, "utf8")) : null;
}

// No V2 as regras external_directory vivem no array `permissions` de topo, com
// action "external_directory" e o caminho canónico como resource.
function externalRules(config) {
  return readRules(config, { agent: null }).filter((r) => r?.action === "external_directory");
}

function externalEffect(config, resource) {
  return externalRules(config).find((r) => r.resource === resource)?.effect;
}

function agentRule(config, agent, action, resource) {
  return readRules(config, { agent }).find((r) => r?.action === action && r?.resource === resource);
}

test("normalizeExternalPath resolve relativo ao cwd e normaliza separadores", () => {
  const cwd = tempDir();
  const out = normalizeExternalPath("foo/bar", cwd);
  assert.equal(out, toPosix(join(cwd, "foo", "bar")));
  assert.ok(!out.includes("\\"), "não deve ter backslashes");
});

test("normalizeExternalPath passa absoluto sem alterar (normalizado)", () => {
  const cwd = tempDir();
  const abs = toPosix(join(cwd, "x"));
  assert.equal(normalizeExternalPath(abs, cwd), abs);
});

test("normalizeExternalPath expande ~ para a home", () => {
  const cwd = tempDir();
  const out = normalizeExternalPath("~/pasta", cwd);
  assert.equal(out, toPosix(join(homedir(), "pasta")));
});

test("toExternalPatterns cobre a pasta e o conteúdo", () => {
  const abs = toPosix(join(tempDir(), "ext"));
  assert.deepEqual(toExternalPatterns(abs), [abs, `${abs}/**`]);
});

test("addExternalDirectoryPatterns adiciona as duas regras sem duplicar", () => {
  const config = {};
  const first = addExternalDirectoryPatterns(config, toExternalPatterns("/x/ext"));
  assert.equal(first.changed, true);
  assert.deepEqual(first.added, ["/x/ext", "/x/ext/**"]);

  const second = addExternalDirectoryPatterns(config, toExternalPatterns("/x/ext"));
  assert.equal(second.changed, false, "idempotente");
  assert.equal(externalRules(config).length, 2);
  assert.equal(externalEffect(config, "/x/ext"), "allow");
});

test("removeExternalDirectoryPatterns remove só os padrões pedidos", () => {
  const config = {};
  addExternalDirectoryPatterns(config, ["/x/a", "/x/a/**", "/x/b", "/x/b/**"]);
  const result = removeExternalDirectoryPatterns(config, ["/x/a", "/x/a/**"]);
  assert.deepEqual(result.removed, ["/x/a", "/x/a/**"]);
  assert.deepEqual(
    externalRules(config).map((r) => r.resource),
    ["/x/b", "/x/b/**"],
    "as regras da outra pasta ficam"
  );
});

test("addAllowedFolder cria a lista canónica e o external_directory", async () => {
  const dir = tempDir();
  const ext = join(dir, "ext");
  mkdirSync(ext);

  const result = await addAllowedFolder({ projectDir: dir, path: ext });

  assert.equal(result.changed, true);
  const list = await loadAllowedFolders(dir);
  assert.equal(list.folders.length, 1);
  assert.equal(list.folders[0].source, "manual");
  assert.equal(list.folders[0].path, toPosix(ext));

  const config = readConfig(dir);
  assert.equal(externalEffect(config, toPosix(ext)), "allow");
  assert.equal(externalEffect(config, `${toPosix(ext)}/**`), "allow");
  assert.ok(existsSync(allowedFoldersPath(dir)));
});

test("addAllowedFolder valida que a pasta existe", async () => {
  const dir = tempDir();
  await assert.rejects(
    addAllowedFolder({ projectDir: dir, path: join(dir, "nao-existe") }),
    /não existe/
  );
  const list = await loadAllowedFolders(dir);
  assert.equal(list.folders.length, 0, "lista deve continuar vazia");
});

test("addAllowedFolder é idempotente (não duplica)", async () => {
  const dir = tempDir();
  const ext = join(dir, "ext");
  mkdirSync(ext);
  await addAllowedFolder({ projectDir: dir, path: ext });
  const second = await addAllowedFolder({ projectDir: dir, path: ext });
  assert.equal(second.changed, false);
  const list = await loadAllowedFolders(dir);
  assert.equal(list.folders.length, 1);
  assert.equal(externalRules(readConfig(dir)).length, 2, "as duas regras external_directory não são duplicadas");
});

test("addAllowedFolder preserva regras manuais do utilizador no external_directory", async () => {
  const dir = tempDir();
  const ext = join(dir, "ext");
  mkdirSync(ext);
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ permissions: [{ action: "external_directory", resource: "~/outro/**", effect: "deny" }] }),
    "utf8"
  );

  await addAllowedFolder({ projectDir: dir, path: ext });

  const config = readConfig(dir);
  assert.equal(externalEffect(config, "~/outro/**"), "deny", "regra manual preservada");
  assert.equal(externalEffect(config, toPosix(ext)), "allow");
});

test("removeAllowedFolder limpa a lista e o external_directory da pasta", async () => {
  const dir = tempDir();
  const ext = join(dir, "ext");
  mkdirSync(ext);
  await addAllowedFolder({ projectDir: dir, path: ext });

  const result = await removeAllowedFolder({ projectDir: dir, path: ext });
  assert.equal(result.changed, true);

  const list = await loadAllowedFolders(dir);
  assert.equal(list.folders.length, 0);
  const config = readConfig(dir);
  assert.deepEqual(externalRules(config), [], "as regras external_directory da pasta desapareceram");
  assert.equal(config.permissions, undefined, "a lista vazia apaga a chave permissions");
});

test("removeAllowedFolder não apaga entradas de outras pastas", async () => {
  const dir = tempDir();
  const a = join(dir, "a");
  const b = join(dir, "b");
  mkdirSync(a);
  mkdirSync(b);
  await addAllowedFolder({ projectDir: dir, path: a });
  await addAllowedFolder({ projectDir: dir, path: b });

  await removeAllowedFolder({ projectDir: dir, path: a });

  const config = readConfig(dir);
  assert.equal(externalEffect(config, toPosix(a)), undefined);
  assert.equal(externalEffect(config, `${toPosix(a)}/**`), undefined);
  assert.equal(externalEffect(config, toPosix(b)), "allow");
  assert.equal(externalEffect(config, `${toPosix(b)}/**`), "allow");
});

test("removeAllowedFolder reporta quando a pasta não está na lista", async () => {
  const dir = tempDir();
  const ext = join(dir, "ext");
  mkdirSync(ext);
  const result = await removeAllowedFolder({ projectDir: dir, path: ext });
  assert.equal(result.changed, false);
});

test("clearAllowedFolders remove todas as pastas", async () => {
  const dir = tempDir();
  const a = join(dir, "a");
  const b = join(dir, "b");
  mkdirSync(a);
  mkdirSync(b);
  await addAllowedFolder({ projectDir: dir, path: a });
  await addAllowedFolder({ projectDir: dir, path: b });

  const result = await clearAllowedFolders({ projectDir: dir });
  assert.equal(result.changed, true);
  assert.equal(result.removed.length, 2);
  assert.equal((await loadAllowedFolders(dir)).folders.length, 0);
  const config = readConfig(dir);
  assert.equal(externalRules(config).length, 0, "nenhuma regra external_directory sobrevive");
});

test("clearAllowedFolders com lista vazia é no-op", async () => {
  const dir = tempDir();
  const result = await clearAllowedFolders({ projectDir: dir });
  assert.equal(result.changed, false);
});

test("listAllowedFolders lista as pastas guardadas", async () => {
  const dir = tempDir();
  const ext = join(dir, "ext");
  mkdirSync(ext);
  await addAllowedFolder({ projectDir: dir, path: ext, source: "manual" });
  const out = [];
  await listAllowedFolders(dir, (line) => out.push(line));
  assert.equal(out.length, 1);
  assert.ok(out[0].includes(toPosix(ext)));
});

test("listAllowedFolders com lista vazia informa", async () => {
  const dir = tempDir();
  const out = [];
  await listAllowedFolders(dir, (line) => out.push(line));
  assert.match(out.join("\n"), /nenhuma/);
});

test("loadAllowedFolders devolve default quando o ficheiro não existe", async () => {
  const dir = tempDir();
  const list = await loadAllowedFolders(dir);
  assert.deepEqual(list, { version: 1, folders: [] });
});

test("writeExternalDirectory é aditivo e idempotente", async () => {
  const dir = tempDir();
  const ext = toPosix(join(dir, "ext"));
  await writeExternalDirectory(dir, { addPatterns: toExternalPatterns(ext) });
  const second = await writeExternalDirectory(dir, { addPatterns: toExternalPatterns(ext) });
  assert.equal(second.changed, false);
  const config = readConfig(dir);
  assert.equal(externalEffect(config, ext), "allow");
  assert.equal(externalEffect(config, `${ext}/**`), "allow");
});

test("writeExternalDirectory com dryRun não escreve", async () => {
  const dir = tempDir();
  const ext = toPosix(join(dir, "ext"));
  await writeExternalDirectory(dir, { addPatterns: toExternalPatterns(ext), dryRun: true });
  assert.equal(existsSync(findConfigFile(dir)), false);
});

test("writeExternalDirectory faz backup do opencode.json existente", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ custom: 1 }), "utf8");
  const ext = toPosix(join(dir, "ext"));
  await writeExternalDirectory(dir, { addPatterns: toExternalPatterns(ext) });
  const backup = join(dir, "opencode.json.bak-loop-development");
  assert.ok(existsSync(backup));
  assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), { custom: 1 });
  const config = readConfig(dir);
  assert.equal(config.custom, 1);
});

// ---------------------------------------------------------------------------
// Alargamento defensivo de **/.loop-development/** (M003)
// ---------------------------------------------------------------------------

// A função itera INTERNAL_STATE_AGENTS × {read, glob, edit}, por isso o número
// de regras depende de quantos agentes o config já declara com um "*" allow.
test("extendLoopDevPatterns alarga read/glob/edit nos agentes internos sem '*'", () => {
  const config = {
    agents: {
      "context-loader": { permissions: [{ action: "read", resource: ".loop-development/**", effect: "allow" }] },
      "state-manager": { permissions: [{ action: "read", resource: "*", effect: "allow" }] }
    }
  };

  const { changed, config: out, added } = extendLoopDevPatterns(config);

  assert.equal(changed, true);
  // A função varre todos os agentes internos; os que não existem no config também
  // recebem as três regras. Só state-manager:read fica de fora (já tem "*").
  assert.equal(added.length, INTERNAL_STATE_AGENTS.length * 3 - 1);
  assert.ok(added.includes("context-loader:read"));
  assert.ok(!added.includes("state-manager:read"), "a acção com '*' é saltada");

  const broad = (action) => ({ action, resource: "**/.loop-development/**", effect: "allow" });
  for (const action of ["read", "glob", "edit"]) {
    assert.deepEqual(agentRule(out, "context-loader", action, "**/.loop-development/**"), broad(action), `context-loader:${action}`);
  }

  // state-manager já tem "*" allow em read: essa acção é saltada, as outras duas
  // entram.
  assert.equal(agentRule(out, "state-manager", "read", "**/.loop-development/**"), undefined, "com '*' não precisa");
  assert.deepEqual(agentRule(out, "state-manager", "glob", "**/.loop-development/**"), broad("glob"));
  assert.deepEqual(agentRule(out, "state-manager", "edit", "**/.loop-development/**"), broad("edit"));
});

test("extendLoopDevPatterns cobre todos os agentes internos que não têm '*'", () => {
  const { config: out } = extendLoopDevPatterns({});

  const expected = [];
  for (const agent of INTERNAL_STATE_AGENTS) {
    for (const action of ["read", "glob", "edit"]) {
      expected.push(`${agent}:${action}`);
      assert.deepEqual(
        agentRule(out, agent, action, "**/.loop-development/**"),
        { action, resource: "**/.loop-development/**", effect: "allow" },
        `${agent} devia receber ${action}`
      );
    }
  }
  assert.equal(expected.length, INTERNAL_STATE_AGENTS.length * 3);
});

test("extendLoopDevPatterns não toca nas outras acções nem nas regras existentes", () => {
  const original = { action: "read", resource: ".loop-development/**", effect: "allow" };
  const config = { agents: { "context-loader": { permissions: [original] } } };
  const { config: out } = extendLoopDevPatterns(config);

  assert.ok(
    readRules(out, { agent: "context-loader" }).includes(original),
    "a regra original do utilizador mantém-se exactamente igual"
  );
  assert.equal(
    readRules(out, { agent: "context-loader" }).filter((r) => r.resource === "**/.loop-development/**").length,
    3,
    "uma regra por acção, nada a duplicar"
  );
});

test("extendLoopDevPatterns é idempotente", () => {
  const config = {
    agents: {
      "context-loader": { permissions: [{ action: "read", resource: ".loop-development/**", effect: "allow" }] }
    }
  };
  const first = extendLoopDevPatterns(config);
  const second = extendLoopDevPatterns(first.config);
  assert.equal(second.changed, false);
  assert.equal(second.added.length, 0);
});

test("shrinkLoopDevPatterns remove o padrão estendido e mantém o original", () => {
  const config = {
    agents: {
      "context-loader": {
        permissions: [
          { action: "read", resource: ".loop-development/**", effect: "allow" },
          { action: "read", resource: "**/.loop-development/**", effect: "allow" }
        ]
      }
    }
  };

  const { changed, config: out, removed } = shrinkLoopDevPatterns(config);

  assert.equal(changed, true);
  assert.deepEqual(removed, ["context-loader:read"]);
  assert.equal(agentRule(out, "context-loader", "read", "**/.loop-development/**"), undefined);
  assert.deepEqual(
    agentRule(out, "context-loader", "read", ".loop-development/**"),
    { action: "read", resource: ".loop-development/**", effect: "allow" },
    "mantém o padrão original"
  );
});

test("shrinkLoopDevPatterns é idempotente", () => {
  const first = shrinkLoopDevPatterns({ agents: { "context-loader": { permissions: [{ action: "read", resource: "**/.loop-development/**", effect: "allow" }] } } });
  assert.equal(first.removed.length, 1);
  const second = shrinkLoopDevPatterns(first.config);
  assert.equal(second.changed, false);
});