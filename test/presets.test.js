import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BACKEND_PRESETS,
  FRONTEND_PRESETS,
  PACKAGE_MANAGERS,
  findPreset,
  resolvePm,
  isValidPm,
  detectPackageManager,
  buildAgentsMd
} from "../src/presets.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-presets-"));
}

test("presets têm schema completo e ids únicos", () => {
  for (const p of [...BACKEND_PRESETS, ...FRONTEND_PRESETS]) {
    assert.equal(typeof p.id, "string");
    assert.equal(typeof p.label, "string");
    assert.equal(typeof p.stack, "string");
    assert.ok(Array.isArray(p.conventions) && p.conventions.length > 0);
    assert.ok(Array.isArray(p.commands) && p.commands.length > 0);
    assert.ok(Array.isArray(p.structure) && p.structure.length > 0);
    assert.ok(Array.isArray(p.never) && p.never.length > 0);
    for (const c of p.commands) {
      assert.equal(typeof c.label, "string");
      assert.equal(typeof c.command, "string");
    }
  }
  const ids = [...BACKEND_PRESETS, ...FRONTEND_PRESETS].map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("BACKEND_PRESETS e FRONTEND_PRESETS têm as stacks acordadas", () => {
  const backendIds = BACKEND_PRESETS.map((p) => p.id);
  const frontendIds = FRONTEND_PRESETS.map((p) => p.id);
  assert.deepEqual(backendIds, ["nestjs-prisma", "nestjs-supabase", "express", "fastify"]);
  assert.deepEqual(frontendIds, ["expo", "next", "vite"]);
});

test("findPreset devolve o preset ou null", () => {
  assert.equal(findPreset("backend", "nestjs-prisma").label, "NestJS + Prisma");
  assert.equal(findPreset("frontend", "expo").label, "Expo (React Native)");
  assert.equal(findPreset("backend", "inexistente"), null);
  assert.equal(findPreset("frontend", null), null);
});

test("resolvePm e isValidPm", () => {
  assert.equal(resolvePm("pnpm").run, "pnpm");
  assert.equal(resolvePm(null).id, "npm");
  assert.equal(resolvePm("inexistente").id, "npm");
  assert.equal(isValidPm("yarn"), true);
  assert.equal(isValidPm("conda"), false);
  assert.equal(isValidPm(null), true);
});

test("buildAgentsMd gera as 5 secções com comandos do gestor escolhido", () => {
  const md = buildAgentsMd({ backend: "nestjs-prisma", frontend: "expo", pm: "pnpm" });
  assert.match(md, /^# AGENTS\.md$/m);
  assert.match(md, /## Stack/);
  assert.match(md, /## Convenções/);
  assert.match(md, /## Comandos do projeto/);
  assert.match(md, /## Estrutura de pastas relevante/);
  assert.match(md, /## O que nunca fazer/);
  assert.match(md, /NestJS 11 \(Express\) \+ Prisma 7/);
  assert.match(md, /Expo SDK 55/);
  assert.match(md, /- Dev \(backend\): pnpm start:dev/);
  assert.match(md, /- Dev \(frontend\): npx expo start/);
  assert.match(md, /- Typecheck: npx tsc --noEmit/);
  assert.match(md, /- Lint \(frontend\): npx expo lint/);
});

test("buildAgentsMd usa o prefixo do gestor", () => {
  assert.match(buildAgentsMd({ backend: "express", pm: "bun" }), /- Dev: bun run dev/);
  assert.match(buildAgentsMd({ backend: "fastify", pm: "yarn" }), /- Testes: yarn test/);
  assert.match(buildAgentsMd({ backend: "express", pm: "npm" }), /- Dev: npm run dev/);
});

test("buildAgentsMd só com backend ou só com frontend", () => {
  const onlyBackend = buildAgentsMd({ backend: "fastify", pm: "npm" });
  assert.doesNotMatch(onlyBackend, /\(backend\)/);
  const onlyFrontend = buildAgentsMd({ frontend: "vite", pm: "npm" });
  assert.match(onlyFrontend, /React \+ Vite/);
  assert.doesNotMatch(onlyFrontend, /\(frontend\)/);
});

test("buildAgentsMd rejeita presets ou gestor desconhecidos", () => {
  assert.throws(() => buildAgentsMd({ backend: "x" }), /Preset de backend desconhecido: x/);
  assert.throws(() => buildAgentsMd({ frontend: "x" }), /Preset de frontend desconhecido: x/);
  assert.throws(() => buildAgentsMd({ backend: "express", pm: "conda" }), /Gestor de pacotes desconhecido: conda/);
  assert.throws(() => buildAgentsMd({}), /requer pelo menos um preset/);
});

test("detectPackageManager deteta lockfiles e packageManager", async () => {
  const byLock = tempDir();
  writeFileSync(join(byLock, "pnpm-lock.yaml"), "lockfileVersion: 9", "utf8");
  assert.equal(await detectPackageManager(byLock), "pnpm");

  const byPackageManager = tempDir();
  writeFileSync(join(byPackageManager, "package.json"), JSON.stringify({ packageManager: "yarn@4.1.0" }), "utf8");
  assert.equal(await detectPackageManager(byPackageManager), "yarn");

  const none = tempDir();
  assert.equal(await detectPackageManager(none), null);
});

test("PACKAGE_MANAGERS cobre npm/pnpm/yarn/bun com run correto", () => {
  const byId = new Map(PACKAGE_MANAGERS.map((p) => [p.id, p.run]));
  assert.equal(byId.get("npm"), "npm run");
  assert.equal(byId.get("pnpm"), "pnpm");
  assert.equal(byId.get("yarn"), "yarn");
  assert.equal(byId.get("bun"), "bun run");
});
