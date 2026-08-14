import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  link,
  unlink,
  findParentProject,
  findChildProjects,
  isValidLoopDevDir,
  loadProjectState,
  saveProjectState,
  defaultState
} from "../src/link.js";
import { toPosix } from "../src/access.js";
import { findConfigFile, parseConfig, getPath } from "../src/merge-config.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-link-"));
}

function createProject(dir, { name = "proj" } = {}) {
  mkdirSync(join(dir, ".loop-development"), { recursive: true });
  writeFileSync(
    join(dir, ".loop-development", "state.json"),
    JSON.stringify({ ...defaultState(dir), version: 2, plans: [], active_plan: null }, null, 2),
    "utf8"
  );
  return dir;
}

function readConfig(dir) {
  const file = findConfigFile(dir);
  return existsSync(file) ? parseConfig(readFileSync(file, "utf8")) : null;
}

function mkMonoRepo() {
  const root = tempDir();
  const main = createProject(join(root, "project-x"), { name: "main" });
  const child = createProject(join(main, "pasta-x"), { name: "child" });
  return { root, main, child };
}

test("isValidLoopDevDir aceita state.json válido e rejeita ausente/inválido", () => {
  const root = tempDir();
  assert.equal(isValidLoopDevDir(root), false);
  createProject(root);
  assert.equal(isValidLoopDevDir(root), true);
  writeFileSync(join(root, ".loop-development", "state.json"), "{ inválido", "utf8");
  assert.equal(isValidLoopDevDir(root), false);
});

test("findParentProject encontra o ancestral mais próximo com loop-development", () => {
  const { main, child } = mkMonoRepo();
  assert.equal(findParentProject(child), main);
  assert.equal(findParentProject(main), null, "o próprio main não é ancestral de si");
});

test("findParentProject respeita maxDepth", () => {
  const root = tempDir();
  const main = createProject(join(root, "a"));
  const child = createProject(join(main, "b"));
  createProject(join(child, "c"));
  const grandchild = join(child, "c");
  assert.equal(findParentProject(grandchild, { maxDepth: 1 }), child, "profundidade 1 encontra o pai direto");
  assert.equal(findParentProject(grandchild, { maxDepth: 2 }), child, "mais próximo vence mesmo com mais profundidade");
  assert.equal(findParentProject(child, { maxDepth: 1 }), main);
});

test("findParentProject com maxDepth 0 não encontra nada", () => {
  const { main, child } = mkMonoRepo();
  assert.equal(findParentProject(child, { maxDepth: 0 }), null);
});

test("findChildProjects encontra children a profundidade 1 e ignora node_modules/.git/ocultas", async () => {
  const root = tempDir();
  const main = createProject(join(root, "project-x"));
  createProject(join(main, "pasta-x"));
  createProject(join(main, "pasta-z"));
  createProject(join(main, "pasta-x", "nested"));
  mkdirSync(join(main, "node_modules", ".loop-development"), { recursive: true });
  writeFileSync(join(main, "node_modules", ".loop-development", "state.json"), JSON.stringify({ version: 2, plans: [] }), "utf8");
  mkdirSync(join(main, ".git"));
  createProject(join(main, ".hidden"));

  const children = await findChildProjects(main, { maxDepth: 1 });
  const paths = children.map((c) => toPosix(c));
  assert.ok(paths.includes(toPosix(join(main, "pasta-x"))));
  assert.ok(paths.includes(toPosix(join(main, "pasta-z"))));
  assert.ok(!paths.includes(toPosix(join(main, "pasta-x", "nested"))), "netos fora do alcance");
  assert.ok(!paths.some((p) => p.includes("node_modules")), "node_modules ignorado");
  assert.ok(!paths.some((p) => p.includes(".git")), ".git ignorado");
  assert.ok(!paths.some((p) => p.includes(".hidden")), "ocultas ignoradas");
});

test("findChildProjects default maxDepth 1 não desce para netos", async () => {
  const root = tempDir();
  const main = createProject(join(root, "project-x"));
  createProject(join(main, "a", "b"));
  const children = await findChildProjects(main);
  assert.equal(children.length, 0, "child a profundidade 2 não é direto");
});

test("link liga child ao main: estado, children[] do main e grants", async () => {
  const { main, child } = mkMonoRepo();

  const changes = await link({ projectDir: child });

  assert.ok(changes.parent, "parent detetado");
  assert.equal(changes.parent.path, toPosix(main));

  const childState = await loadProjectState(child);
  assert.equal(childState.parent.path, toPosix(main));
  assert.equal(childState.parent.name, "project-x");

  const mainState = await loadProjectState(main);
  assert.equal(mainState.children.length, 1);
  assert.equal(mainState.children[0].path, toPosix(child));

  const config = readConfig(child);
  const ed = getPath(config, "permission.external_directory");
  assert.equal(ed[toPosix(main)], "allow");
  assert.equal(ed[`${toPosix(main)}/**`], "allow");
});

test("link é idempotente", async () => {
  const { child } = mkMonoRepo();
  await link({ projectDir: child });
  const second = await link({ projectDir: child });
  assert.equal(second.parent, null, "segunda execução não re-regista parent");
  assert.equal(second.parentChildrenAdded, null, "main já tinha o child");
});

test("link do main regista children descendentes", async () => {
  const { main } = mkMonoRepo();
  const changes = await link({ projectDir: main });
  assert.equal(changes.childrenAdded.length, 1);
  assert.ok(changes.childrenAdded.includes(toPosix(join(main, "pasta-x"))));
  const state = await loadProjectState(main);
  assert.equal(state.children.length, 1);
  assert.equal(state.parent, undefined, "main não tem parent");
});

test("link reconcilia children stale (child apagado é removido)", async () => {
  const { main, child } = mkMonoRepo();
  await link({ projectDir: main });
  const state = await loadProjectState(main);
  assert.equal(state.children.length, 1);

  const { rmSync } = await import("node:fs");
  rmSync(child, { recursive: true, force: true });

  const changes = await link({ projectDir: main });
  assert.equal(changes.childrenRemoved.length, 1);
  const after = await loadProjectState(main);
  assert.equal(after.children.length, 0);
});

test("link limpa parent stale quando o main deixa de ser válido", async () => {
  const { main, child } = mkMonoRepo();
  await link({ projectDir: child });
  const { rmSync } = await import("node:fs");
  rmSync(join(main, ".loop-development"), { recursive: true, force: true });

  const changes = await link({ projectDir: child });
  assert.equal(changes.parentCleared, true);
  const state = await loadProjectState(child);
  assert.equal(state.parent, null);
});

test("link cria state.json quando o projeto não o tem (main acima)", async () => {
  const root = tempDir();
  const main = createProject(join(root, "project-x"));
  const child = join(main, "novo");
  mkdirSync(child, { recursive: true });
  assert.equal(isValidLoopDevDir(child), false);

  const changes = await link({ projectDir: child });

  assert.ok(changes.parent);
  assert.equal(isValidLoopDevDir(child), true, "state.json criado");
  const state = await loadProjectState(child);
  assert.equal(state.parent.path, toPosix(main));
});

test("link com dryRun não escreve nada", async () => {
  const { main, child } = mkMonoRepo();
  const before = readFileSync(join(child, ".loop-development", "state.json"), "utf8");

  await link({ projectDir: child, dryRun: true });

  assert.equal(readFileSync(join(child, ".loop-development", "state.json"), "utf8"), before, "state do child intacto");
  assert.equal(existsSync(findConfigFile(child)), false, "sem opencode.json");
  const mainState = await loadProjectState(main);
  assert.equal(mainState.children, undefined, "main não regista com dryRun");
});

test("link suporta cadeias (child que também é main)", async () => {
  const root = tempDir();
  const main = createProject(join(root, "project-x"));
  const mid = createProject(join(main, "pasta-x"));
  createProject(join(mid, "sub"));

  await link({ projectDir: mid });

  const midState = await loadProjectState(mid);
  assert.equal(midState.parent.path, toPosix(main), "mid é child do main");
  assert.equal(midState.children.length, 1, "mid é main de sub");
});

test("unlink desliga o child do main (estado + grants)", async () => {
  const { main, child } = mkMonoRepo();
  await link({ projectDir: child });

  const result = await unlink({ projectDir: child, path: main });

  assert.equal(result.role, "parent");
  const childState = await loadProjectState(child);
  assert.equal(childState.parent, null);
  const mainState = await loadProjectState(main);
  assert.equal(mainState.children.length, 0, "main perde o child");

  const config = readConfig(child);
  assert.equal(getPath(config, "permission.external_directory"), undefined, "grants removidos");
});

test("unlink do main desliga o child", async () => {
  const { main, child } = mkMonoRepo();
  await link({ projectDir: main });

  const result = await unlink({ projectDir: main, path: child });

  assert.equal(result.role, "child");
  const state = await loadProjectState(main);
  assert.equal(state.children.length, 0);
});

test("unlink com caminho sem ligação falha", async () => {
  const { child } = mkMonoRepo();
  const other = join(child, "outra");
  mkdirSync(other, { recursive: true });
  await assert.rejects(unlink({ projectDir: child, path: other }), /sem ligação/);
});

test("saveProjectState preserva os campos existentes", async () => {
  const root = tempDir();
  createProject(root);
  const state = await loadProjectState(root);
  state.parent = { path: "/x", name: "x" };
  state.plans = [{ id: "1" }];
  await saveProjectState(root, state);
  const reloaded = await loadProjectState(root);
  assert.equal(reloaded.parent.path, "/x");
  assert.equal(reloaded.plans.length, 1);
  assert.ok(reloaded.last_updated);
});
