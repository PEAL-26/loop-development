import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldPlan, migrateProject, detectLegacyLayout, planId, slugify, timestampPrefix, currentMonthShard } from "../src/plan.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-plan-"));
}

const FIXED_DATE = new Date(2026, 7, 8, 22, 46); // 2026-08-08 22:46

test("slugify normaliza e limita a 40 chars", () => {
  assert.equal(slugify("Login Google"), "login-google");
  assert.equal(slugify("  a   b  "), "a-b");
  assert.equal(slugify("áéí ção"), "aei-cao");
  assert.equal(slugify("".repeat(0)), "plano");
  assert.equal(slugify("x".repeat(60)).length <= 40, true);
});

test("planId combina timestamp e slug", () => {
  assert.equal(planId(FIXED_DATE, "Login Google"), "20260808.2246-login-google");
  assert.equal(timestampPrefix(FIXED_DATE), "20260808.2246");
  assert.equal(currentMonthShard(FIXED_DATE), "2026-08");
});

test("scaffoldPlan cria o esqueleto do plano", async () => {
  const dir = tempDir();
  const { id, dir: planDir } = await scaffoldPlan({ targetDir: dir, slug: "auth", date: FIXED_DATE });

  assert.equal(id, "20260808.2246-auth");
  for (const f of ["state.json", "spec.md", "decisions.md", "clarifications.md", "implementation-log/index.md", `implementation-log/2026-08.md`]) {
    assert.ok(existsSync(join(planDir, f)), `falta ${f}`);
  }
  for (const d of ["tasks", "summaries", "metrics"]) {
    assert.ok(existsSync(join(planDir, d)), `falta pasta ${d}`);
  }

  const state = JSON.parse(readFileSync(join(planDir, "state.json"), "utf8"));
  assert.equal(state.phase, "intake");
  assert.deepEqual(state.tasks_done, []);
  assert.deepEqual(state.tasks_pending, []);
  assert.equal(state.current_task, null);
  assert.equal(state.grill_status, null);
  assert.equal(state.tasks_approved_at, null);
  assert.equal(state.tasks_approval_source, null);
});

test("detectLegacyLayout deteta formato antigo", () => {
  const dir = tempDir();
  const root = join(dir, ".loop-development");
  assert.equal(detectLegacyLayout(dir), false); // sem pasta
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "state.json"), JSON.stringify({ phase: "intake", current_ticket: null }), "utf8");
  assert.equal(detectLegacyLayout(dir), true);
  writeFileSync(join(root, "state.json"), JSON.stringify({ version: 2, active_plan: null, plans: [] }), "utf8");
  assert.equal(detectLegacyLayout(dir), false);
  mkdirSync(join(root, "plans"));
  assert.equal(detectLegacyLayout(dir), false);
});

test("migrateProject converte flat para planos", async () => {
  const dir = tempDir();
  const root = join(dir, ".loop-development");
  mkdirSync(join(root, "tickets"), { recursive: true });
  writeFileSync(join(root, "state.json"), JSON.stringify({ phase: "execute", current_ticket: "001-x", tickets_done: ["001-x"], tickets_pending: ["002-y"], min_coverage: 70, created_at: "t0" }), "utf8");
  writeFileSync(join(root, "roadmap.md"), "# Roadmap antigo", "utf8");
  writeFileSync(join(root, "decisions.md"), "# Decisões", "utf8");
  writeFileSync(join(root, "implementation-log.md"), "## 2026-08-01 tick", "utf8");
  writeFileSync(join(root, "architecture.md"), "# Arch", "utf8");
  writeFileSync(join(root, "risks.md"), "# Riscos", "utf8");
  writeFileSync(join(root, "tickets", "001-x.md"), "tarefa", "utf8");

  const res = await migrateProject({ targetDir: dir, date: FIXED_DATE, log: () => {} });

  assert.equal(res.migrated, true);
  const planDir = join(root, "plans", res.id);
  assert.ok(existsSync(join(planDir, "spec.md")), "roadmap→spec.md");
  assert.ok(existsSync(join(planDir, "decisions.md")));
  assert.ok(existsSync(join(planDir, "implementation-log", "2026-08.md")));
  assert.ok(existsSync(join(planDir, "implementation-log", "index.md")));
  assert.ok(existsSync(join(planDir, "tasks", "001-x.md")), "tickets/→tasks/");
  assert.ok(!existsSync(join(root, "roadmap.md")));
  assert.ok(!existsSync(join(root, "tickets")));

  const planState = JSON.parse(readFileSync(join(planDir, "state.json"), "utf8"));
  assert.equal(planState.phase, "execute");
  assert.equal(planState.current_task, "001-x");
  assert.deepEqual(planState.tasks_done, ["001-x"]);
  assert.deepEqual(planState.tasks_pending, ["002-y"]);

  const projectState = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.equal(projectState.version, 2);
  assert.equal(projectState.active_plan, res.id);
  assert.equal(projectState.plans.length, 1);
  assert.equal(projectState.min_coverage, 70);
  assert.ok(existsSync(join(root, "architecture.md")), "nível de projeto preservado");
});

test("migrateProject em estrutura já nova não faz nada", async () => {
  const dir = tempDir();
  const root = join(dir, ".loop-development");
  mkdirSync(join(root, "plans"), { recursive: true });
  writeFileSync(join(root, "state.json"), JSON.stringify({ version: 2, active_plan: null, plans: [] }), "utf8");
  const res = await migrateProject({ targetDir: dir, log: () => {} });
  assert.equal(res.migrated, false);
});

test("migrateProject dry-run não altera nada", async () => {
  const dir = tempDir();
  const root = join(dir, ".loop-development");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "state.json"), JSON.stringify({ phase: "intake" }), "utf8");
  writeFileSync(join(root, "roadmap.md"), "# Roadmap", "utf8");

  const res = await migrateProject({ targetDir: dir, dryRun: true, date: FIXED_DATE, log: () => {} });
  assert.equal(res.dryRun, true);
  assert.ok(existsSync(join(root, "roadmap.md")), "dry-run não move ficheiros");
  assert.ok(!existsSync(join(root, "plans")));
});
