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
  allowedFoldersPath
} from "../src/access.js";
import { findConfigFile, parseConfig, getPath } from "../src/merge-config.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-access-"));
}

function readConfig(dir) {
  const file = findConfigFile(dir);
  return existsSync(file) ? parseConfig(readFileSync(file, "utf8")) : null;
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
  const ed = getPath(config, "permission.external_directory");
  assert.equal(ed[toPosix(ext)], "allow");
  assert.equal(ed[`${toPosix(ext)}/**`], "allow");
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
});

test("addAllowedFolder preserva regras manuais do utilizador no external_directory", async () => {
  const dir = tempDir();
  const ext = join(dir, "ext");
  mkdirSync(ext);
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ permission: { external_directory: { "~/outro/**": "deny" } } }), "utf8");

  await addAllowedFolder({ projectDir: dir, path: ext });

  const config = readConfig(dir);
  const ed = getPath(config, "permission.external_directory");
  assert.equal(ed["~/outro/**"], "deny", "regra manual preservada");
  assert.equal(ed[toPosix(ext)], "allow");
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
  assert.equal(getPath(config, "permission.external_directory"), undefined);
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
  const ed = getPath(config, "permission.external_directory");
  assert.equal(ed[toPosix(a)], undefined);
  assert.equal(ed[toPosix(b)], "allow");
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
  assert.equal(getPath(config, "permission.external_directory"), undefined);
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
  assert.equal(getPath(config, `permission.external_directory.${ext}`), "allow");
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

test("extendLoopDevPatterns alarga agentes sem '*' e ignora com '*'", () => {
  const config = {
    agent: {
      "context-loader": { permission: { read: { ".loop-development/**": "allow" }, edit: { ".loop-development/**": "allow" } } },
      implementer: { permission: { read: { "*": "allow", "*.env": "ask" } } }
    }
  };
  const { changed, config: out, added } = extendLoopDevPatterns(config);
  assert.equal(changed, true);
  assert.equal(added.length, 2);
  assert.equal(out.agent["context-loader"].permission.read["**/.loop-development/**"], "allow");
  assert.equal(out.agent["context-loader"].permission.edit["**/.loop-development/**"], "allow");
  assert.equal(out.agent.implementer.permission.read["**/.loop-development/**"], undefined, "com '*' não precisa");
});

test("extendLoopDevPatterns é idempotente", () => {
  const config = {
    agent: {
      "context-loader": { permission: { read: { ".loop-development/**": "allow" } } }
    }
  };
  const first = extendLoopDevPatterns(config);
  const second = extendLoopDevPatterns(first.config);
  assert.equal(second.changed, false);
});

test("shrinkLoopDevPatterns remove o padrão estendido", () => {
  const config = {
    agent: {
      "context-loader": { permission: { read: { ".loop-development/**": "allow", "**/.loop-development/**": "allow" } } }
    }
  };
  const { changed, config: out, removed } = shrinkLoopDevPatterns(config);
  assert.equal(changed, true);
  assert.equal(removed.length, 1);
  assert.equal(out.agent["context-loader"].permission.read["**/.loop-development/**"], undefined);
  assert.equal(out.agent["context-loader"].permission.read[".loop-development/**"], "allow", "mantém o padrão original");
});
