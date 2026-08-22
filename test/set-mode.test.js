import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setMode, isValidMode } from "../src/set-mode.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-set-mode-"));
}

function createProject(dir, state = {}) {
  mkdirSync(join(dir, ".loop-development"), { recursive: true });
  writeFileSync(
    join(dir, ".loop-development", "state.json"),
    JSON.stringify({ version: 2, active_plan: null, plans: [], min_coverage: 80, ...state }, null, 2),
    "utf8"
  );
  return dir;
}

function readState(dir) {
  return JSON.parse(readFileSync(join(dir, ".loop-development", "state.json"), "utf8"));
}

test("isValidMode aceita apenas simple e complete", () => {
  assert.equal(isValidMode("simple"), true);
  assert.equal(isValidMode("complete"), true);
  assert.equal(isValidMode("simples"), false);
  assert.equal(isValidMode("full"), false);
  assert.equal(isValidMode(undefined), false);
});

test("setMode grava default_mode no state.json do projeto", async () => {
  const dir = tempDir();
  createProject(dir);
  const result = await setMode("simple", { projectDir: dir });
  assert.deepEqual(result, { changed: true, previous: "complete", mode: "simple" });
  const state = readState(dir);
  assert.equal(state.default_mode, "simple");
  assert.ok(state.last_updated);
});

test("setMode preserva o resto do estado", async () => {
  const dir = tempDir();
  createProject(dir, { active_plan: "20260101.0000-x", min_coverage: 90 });
  await setMode("simple", { projectDir: dir });
  const state = readState(dir);
  assert.equal(state.active_plan, "20260101.0000-x");
  assert.equal(state.min_coverage, 90);
  assert.equal(state.default_mode, "simple");
});

test("setMode com valor já igual não altera nada", async () => {
  const dir = tempDir();
  createProject(dir, { default_mode: "simple" });
  const before = readFileSync(join(dir, ".loop-development", "state.json"), "utf8");
  const logs = [];
  const result = await setMode("simple", { projectDir: dir, log: (m) => logs.push(m) });
  assert.deepEqual(result, { changed: false, previous: "simple", mode: "simple" });
  assert.equal(readFileSync(join(dir, ".loop-development", "state.json"), "utf8"), before);
});

test("setMode em falta de campo trata ausência como complete", async () => {
  const dir = tempDir();
  createProject(dir);
  const result = await setMode("complete", { projectDir: dir });
  assert.deepEqual(result, { changed: false, previous: "complete", mode: "complete" });
  const state = readState(dir);
  assert.equal(state.default_mode, undefined, "não escreve quando nada muda");
});

test("setMode rejeita modo inválido sem tocar no estado", async () => {
  const dir = tempDir();
  createProject(dir);
  await assert.rejects(() => setMode("simples", { projectDir: dir }), /modo inválido/);
  const state = readState(dir);
  assert.equal(state.default_mode, undefined);
});

test("setMode sem .loop-development/ lança erro acionável", async () => {
  const dir = tempDir();
  await assert.rejects(() => setMode("simple", { projectDir: dir }), /init --project/);
});

test("setMode com dry-run mostra mas não escreve", async () => {
  const dir = tempDir();
  createProject(dir);
  const result = await setMode("simple", { projectDir: dir, dryRun: true });
  assert.equal(result.changed, true);
  assert.equal(result.dryRun, true);
  const state = readState(dir);
  assert.equal(state.default_mode, undefined);
});
