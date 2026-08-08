import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStatus, status } from "../src/status.js";
import { installGlobal } from "../src/install.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-status-"));
}

test("getStatus lê o plano ativo e as suas tarefas", async () => {
  const dir = tempDir();
  await installGlobal({ configDir: dir });
  const proj = tempDir();

  mkdirSync(join(proj, ".loop-development", "plans", "20260808.2246-auth"), { recursive: true });
  writeFileSync(join(proj, ".loop-development", "state.json"), JSON.stringify({ version: 2, active_plan: "20260808.2246-auth", plans: [{ id: "20260808.2246-auth", name: "auth", status: "in-progress" }], min_coverage: 80 }), "utf8");
  writeFileSync(
    join(proj, ".loop-development", "plans", "20260808.2246-auth", "state.json"),
    JSON.stringify({ phase: "execute", current_task: "002-validar-token", tasks_done: ["001-setup"], tasks_pending: ["002-validar-token"] }),
    "utf8"
  );

  const data = await getStatus({ configDir: dir, projectDir: proj });
  assert.equal(data.projectState.activePlan, "20260808.2246-auth");
  assert.equal(data.projectState.plans.length, 1);
  assert.equal(data.activePlanState.phase, "execute");
  assert.equal(data.activePlanState.currentTask, "002-validar-token");
  assert.equal(data.activePlanState.tasksDone, 1);
  assert.equal(data.activePlanState.tasksPending, 1);
});

test("status sem plano ativo mostra contagem de planos", async () => {
  const dir = tempDir();
  await installGlobal({ configDir: dir });
  const proj = tempDir();

  mkdirSync(join(proj, ".loop-development"), { recursive: true });
  writeFileSync(join(proj, ".loop-development", "state.json"), JSON.stringify({ version: 2, active_plan: null, plans: [{ id: "a", status: "done" }, { id: "b", status: "in-progress" }], min_coverage: 80 }), "utf8");

  const lines = [];
  await status({ configDir: dir, projectDir: proj, log: (s) => lines.push(s) });
  const out = lines.join("\n");
  assert.match(out, /2 planos registados/);
  assert.match(out, /1 em curso/);
  assert.match(out, /1 concluídos/);
  assert.match(out, /sem plano ativo/);
});

test("status com plano ativo sem state.json aconselha migrate", async () => {
  const dir = tempDir();
  await installGlobal({ configDir: dir });
  const proj = tempDir();

  mkdirSync(join(proj, ".loop-development"), { recursive: true });
  writeFileSync(join(proj, ".loop-development", "state.json"), JSON.stringify({ version: 2, active_plan: "legacy-plan", plans: [] }), "utf8");

  const lines = [];
  await status({ configDir: dir, projectDir: proj, log: (s) => lines.push(s) });
  assert.match(lines.join("\n"), /migrate/);
});
