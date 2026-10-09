import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { doctor } from "../src/doctor.js";
import { installGlobal } from "../src/install.js";
import { MANIFEST_FILE } from "../src/manifest.js";
import { PACKAGE_NAME } from "../src/deps.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-doctor-"));
}

// Um `opencode --version` falso no PATH, para que o check da versão não dependa
// do que está instalado na máquina. Sem isto, o teste passaria numa máquina com
// v2 e falharia numa com v1 — e o doctor deixaria de ser testável.
async function withStubbedOpencode(version, fn) {
  const dir = tempDir();
  const prevPath = process.env.PATH;
  if (process.platform === "win32") {
    writeFileSync(join(dir, "opencode.cmd"), `@echo opencode v${version}\r\n`, "ascii");
  } else {
    const bin = join(dir, "opencode");
    writeFileSync(bin, `#!/bin/sh\necho "opencode v${version}"\n`, "ascii");
    chmodSync(bin, 0o755);
  }
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${prevPath}`;
  try {
    return await fn();
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Um log do OpenCode escrito pelo teste. O log real da máquina não pode
// decidir o resultado — daí o doctor aceitar `logFile`.
function fakeOpencodeLog(lines) {
  const file = join(tempDir(), "opencode.log");
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function checkOf(result, name) {
  return result.checks.find((c) => c.name === name);
}

function failedNames(result) {
  return (result.failed ?? []).map((c) => c.name);
}

// Um directório que não é um checkout de desenvolvimento: o check de
// dependências passa sem olhar para node_modules e nunca instala nada.
function notADevCheckout() {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "outro-pacote", version: "1.0.0" }), "utf8");
  return dir;
}

// Instala o pacote uma única vez e copia essa instalação para cada teste.
// Reinstalar por teste custava segundos (escrita de ~40 ficheiros) sem
// acrescentar cobertura nenhuma.
let templatePromise = null;
function installedTemplate() {
  templatePromise ??= (async () => {
    const dir = tempDir();
    await installGlobal({ configDir: dir });
    return dir;
  })();
  return templatePromise;
}

async function installedDir() {
  const template = await installedTemplate();
  const dir = tempDir();
  cpSync(template, dir, { recursive: true });
  return dir;
}

test("doctor aprova uma instalação completa e exit code 0", async () => {
  const configDir = await installedDir();
  const logFile = fakeOpencodeLog(["INFO  serviço arrancado", "INFO  tudo bem"]);

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile, log: () => {} }),
  );

  assert.equal(result.ok, true, `verificações com problemas: ${failedNames(result).join(", ")}`);
  assert.equal(result.failed, undefined, "sem falhas não há lista `failed`");
  assert.equal(result.checks.length, 6, "os seis checks do plano (§4.6)");
  for (const c of result.checks) {
    assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
  }
  // Os três checks que o plano (§4.6) exige ver em detalhe.
  assert.match(checkOf(result, "Manifesto de instalação").detail, /^\d+\.\d+\.\d+$/);
  assert.match(checkOf(result, "Forma do config").detail, /opencode\.jsonc?$/);
  assert.equal(checkOf(result, "Frontmatter dos agentes").detail, null);
  assert.equal(checkOf(result, "Plugins").detail, null);
  assert.equal(checkOf(result, "Dependências").detail, null);
});

test("doctor reprova um OpenCode que ainda é v1", async () => {
  const configDir = await installedDir();

  const result = await withStubbedOpencode("1.9.12", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile: fakeOpencodeLog([]), log: () => {} }),
  );

  const check = checkOf(result, "Versão do OpenCode");
  assert.equal(check.ok, false);
  assert.match(check.detail, /1\.9\.12/);
  // Exit code: uma falha faz o comando falhar, mesmo com tudo o resto em ordem.
  assert.equal(result.ok, false);
  assert.deepEqual(failedNames(result), ["Versão do OpenCode"]);
});

test("doctor deteta config em forma V1", async () => {
  const configDir = tempDir();
  writeFileSync(
    join(configDir, "opencode.json"),
    JSON.stringify({
      agent: { implementer: { mode: "subagent", prompt: "x", permission: { bash: "ask" } } },
      permission: { bash: "allow" },
    }),
    "utf8",
  );

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile: fakeOpencodeLog([]), log: () => {} }),
  );

  const check = checkOf(result, "Forma do config");
  assert.equal(check.ok, false);
  assert.match(check.detail, /"agent" e "permission"/, "o detalhe nomeia as chaves V1");
  assert.match(check.detail, /V1/);
  assert.deepEqual(check.v1Keys, ["agent", "permission"]);
  assert.equal(result.ok, false);
});

test("doctor deteta frontmatter V1 num agente instalado", async () => {
  const configDir = await installedDir();
  // Um .md nosso (o hash no manifesto é o que embarcámos) mas com a forma V1 —
  // exactamente o que o 'update' tem de reparar.
  writeFileSync(join(configDir, "agents", "intake.md"), "---\ndescription: intake\npermission:\n  bash: ask\n---\ncorpo\n", "utf8");

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile: fakeOpencodeLog([]), log: () => {} }),
  );

  const check = checkOf(result, "Frontmatter dos agentes");
  assert.equal(check.ok, false);
  assert.deepEqual(check.offenders, ["intake.md (permission)"]);
  assert.match(check.detail, /1 agente\(s\) com chaves V1/);
  assert.equal(result.ok, false);
});

test("doctor deteta plugin sem export default", async () => {
  const configDir = await installedDir();
  // Sem default export o loader V2 não carrega o plugin — o sintoma que o
  // plano (§4.6) manda caçar.
  writeFileSync(join(configDir, "plugins", "session-title.ts"), "const plugin = () => ({});\nexport const plugin = plugin;\n", "utf8");

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile: fakeOpencodeLog([]), log: () => {} }),
  );

  const check = checkOf(result, "Plugins");
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes("session-title.ts") && p.includes("export default")), check.detail);
  // O telegram.ts está intacto — o problema é só do outro ficheiro.
  assert.equal(check.problems.some((p) => p.includes("telegram.ts")), false);
});

test("doctor falha quando o log do OpenCode regista 'failed to load plugin'", async () => {
  const configDir = await installedDir();
  const logFile = fakeOpencodeLog([
    "INFO  arranque",
    "2026-01-02T03:04:05Z ERROR failed to load plugin /home/ze/.config/opencode/plugins/telegram.ts: unexpected token",
  ]);

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile, log: () => {} }),
  );

  const check = checkOf(result, "Plugins");
  assert.equal(check.ok, false);
  assert.match(check.detail, /failed to load plugin/);
  assert.match(check.detail, /2026-01-02T03:04:05Z/, "a data da última falha vem no detalhe");
  assert.match(check.detail, /reinicia o OpenCode/);
});

test("doctor ignora no log falhas que não são dos nossos plugins", async () => {
  const configDir = await installedDir();
  const logFile = fakeOpencodeLog([
    "2026-01-02T03:04:05Z ERROR failed to load plugin /home/ze/.config/opencode/plugins/alheio.ts: boom",
    "2026-01-02T03:04:06Z ERROR alguma coisa completamente diferente",
  ]);

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile, log: () => {} }),
  );

  assert.equal(checkOf(result, "Plugins").ok, true, "o log só conta quando menciona os nossos plugins");
  assert.equal(result.ok, true);
});

test("doctor falha quando não há nada instalado", async () => {
  const configDir = tempDir();

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile: fakeOpencodeLog([]), log: () => {} }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(failedNames(result), [
    "Manifesto de instalação",
    "Forma do config",
    "Frontmatter dos agentes",
    "Plugins",
  ]);
  assert.match(checkOf(result, "Manifesto de instalação").detail, new RegExp(`sem ${MANIFEST_FILE}`));
  assert.match(checkOf(result, "Forma do config").detail, /sem config/);
  assert.match(checkOf(result, "Frontmatter dos agentes").detail, /sem agentes/);
  assert.ok(checkOf(result, "Plugins").problems.every((p) => p.includes("não está instalado")));
  // Uma lista `failed` só existe quando há mesmo falhas, e traz o detalhe.
  assert.equal(result.failed.length, 4);
  for (const c of result.failed) assert.ok(c.detail != null, `${c.name} tem de explicar o problema`);
});

test("doctor detecta um manifesto com a versão do pacote errada", async () => {
  const configDir = await installedDir();
  const manifest = JSON.parse(
    // O manifesto é reescrito com a versão antiga, como ficaria numa instalação
    // feita por uma versão anterior do pacote.
    readFileSync(join(configDir, MANIFEST_FILE), "utf8"),
  );
  manifest.version = "0.0.1-antiga";
  writeFileSync(join(configDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), "utf8");

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile: fakeOpencodeLog([]), log: () => {} }),
  );

  const check = checkOf(result, "Manifesto de instalação");
  assert.equal(check.ok, false);
  assert.match(check.detail, /instalado em 0\.0\.1-antiga/);
});

test("doctor conta ficheiros embarcados em falta", async () => {
  const configDir = await installedDir();
  rmSync(join(configDir, "agents", "intake.md"));
  rmSync(join(configDir, "plugins", "telegram.ts"));

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile: fakeOpencodeLog([]), log: () => {} }),
  );

  const check = checkOf(result, "Manifesto de instalação");
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing.sort(), ["agents/intake.md", "plugins/telegram.ts"]);
  assert.match(check.detail, /2 ficheiro\(s\) em falta/);
});

test("doctor ignora ficheiros que o utilizador editou (não são erro)", async () => {
  const configDir = await installedDir();
  // O hash instalado deixou de bater com o que embarcámos: é edição local, não
  // uma instalação avariada. O mesmo cuidado que o installer tem.
  writeFileSync(join(configDir, "commands", "loop-development.md"), "---\ndescription: meu\n---\nreescrito\n", "utf8");

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile: fakeOpencodeLog([]), log: () => {} }),
  );

  const check = checkOf(result, "Manifesto de instalação");
  assert.equal(check.ok, true, check.detail);
  assert.deepEqual(check.stale, []);
  assert.equal(result.ok, true);
});

test("doctor reporta dependências em falta num checkout de desenvolvimento sem as instalar", async () => {
  const configDir = await installedDir();
  // Um checkout de desenvolvimento a sério, mas sem node_modules: o check tem de
  // dizer o que falta — sem instalar nada, porque não pedimos --fix.
  const devCheckout = tempDir();
  writeFileSync(join(devCheckout, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "1.0.0" }), "utf8");

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: devCheckout, logFile: fakeOpencodeLog([]), log: () => {} }),
  );

  const check = checkOf(result, "Dependências");
  assert.equal(check.ok, false);
  assert.deepEqual(check.deps.missing, ["@opencode/plugin", "typescript", "@types/node"]);
  assert.match(check.detail, /em falta: @opencode\/plugin, typescript, @types\/node/);
  assert.match(check.detail, /corre com --fix/, "sem --fix o doctor diz como se resolve");
  assert.equal(existsSync(join(devCheckout, "node_modules")), false, "nada foi instalado");
});

test("doctor diz que o check de dependências não se aplica fora do checkout", async () => {
  const configDir = await installedDir();
  const logs = [];

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), logFile: fakeOpencodeLog([]), log: (m) => logs.push(m) }),
  );

  assert.equal(checkOf(result, "Dependências").ok, true);
  assert.equal(result.ok, true);
  assert.ok(
    logs.some((l) => l.includes("fora de um checkout de desenvolvimento")),
    "o log explica porque é que o check não se aplica",
  );
});

test("doctor --dry-run não instala nem escreve nada", async () => {
  const configDir = tempDir();

  const result = await withStubbedOpencode("2.7.3", () =>
    doctor({ configDir, cwd: notADevCheckout(), dryRun: true, logFile: fakeOpencodeLog([]), log: () => {} }),
  );

  assert.equal(result.ok, false, "sem instalação quase nada passa — mas nada é escrito");
  assert.equal(existsSync(join(configDir, MANIFEST_FILE)), false);
  assert.equal(existsSync(join(configDir, "opencode.json")), false);
});
