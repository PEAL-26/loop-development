import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installGlobal, installProject } from "../src/install.js";
import { uninstall } from "../src/uninstall.js";
import { setModel } from "../src/set-model.js";
import { loadManifest, MANIFEST_FILE } from "../src/manifest.js";
import { findConfigFile, parseConfig, readRules } from "../src/merge-config.js";
import { fakeFetch, makeRepoTarball } from "./helpers/tar.js";
import { ensureSkills } from "../src/skills.js";
import { RULES_START, hasRulesBlock } from "../src/rules.js";
import { toPosix } from "../src/access.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-install-"));
}

// Instala uma skill mínima para os testes de integração do installProject.
async function withSkill() {
  const configDir = tempDir();
  await ensureSkills({
    configDir,
    fetchImpl: fakeFetch({
      "codeload.github.com": {
        body: makeRepoTarball("peal-skills-main", [
          { name: "project-rules/SKILL.md", data: "---\nname: project-rules\n---" },
          { name: "project-rules/references/general/security.md", data: "# 5 pilares" },
          { name: "project-rules/references/backend/nestjs.md", data: "# nestjs" },
          { name: "project-rules/references/backend/prisma.md", data: "# prisma" },
        ]),
      },
    }),
    log: () => {},
  });
  return { configDir, skillRoot: join(configDir, "skills", "project-rules") };
}

// No V2 as permissões são arrays ordenados de { action, resource, effect }, e
// vale a última regra que casa. Estes atalhos mantêm as asserções legíveis.
function rulesOf(config, agent = null) {
  return readRules(config, { agent });
}

function effectOf(config, action, resource, agent = null) {
  return rulesOf(config, agent).find((r) => r.action === action && r.resource === resource)?.effect;
}

function hasRule(config, action, resource, agent = null) {
  return rulesOf(config, agent).some((r) => r.action === action && r.resource === resource);
}

test("installGlobal copia assets, mescla config e grava manifesto", async () => {
  const dir = tempDir();
  await installGlobal({ configDir: dir });

  assert.ok(existsSync(join(dir, "agents", "loop-development.md")));
  assert.ok(existsSync(join(dir, "agents", "intake.md")));
  assert.ok(existsSync(join(dir, "commands", "loop-development.md")));
  assert.ok(existsSync(join(dir, "commands", "loop-development-continue.md")));
  assert.ok(existsSync(join(dir, "commands", "loop-development-status.md")));
  assert.ok(existsSync(join(dir, "templates", "AGENTS.md.template")));
  assert.ok(existsSync(join(dir, "templates", ".loop-development", "state.json")));
  assert.ok(existsSync(join(dir, "scripts", "set-model.sh")));
  assert.ok(existsSync(join(dir, "plugins", "telegram.ts")));
  assert.ok(existsSync(join(dir, "plugins", "core", "telegram-core.js")));
  assert.ok(existsSync(join(dir, "plugins", "session-title.ts")));
  assert.ok(existsSync(join(dir, "plugins", "core", "session-title-core.js")));

  const configFile = findConfigFile(dir);
  assert.ok(existsSync(configFile));
  const config = parseConfig(readFileSync(configFile, "utf8"));

  // §3.6: o config global só leva o bloco `permissions` de topo (guardas de
  // shell). As permissões internas dos nossos agentes vivem no frontmatter dos
  // .md — duplicá-las aqui fazia as duas listas aplicarem-se em conjunto.
  assert.equal(config.agent, undefined, 'nada de "agent" (forma V1) no config global');
  assert.equal(config.permission, undefined, 'nada de "permission" (forma V1) no config global');
  assert.equal(config.agents, undefined, "nenhum bloco agents no config global");

  const shell = rulesOf(config).filter((r) => r.action === "shell");
  assert.ok(shell.length >= 30, `esperado o catch-all mais a lista destrutiva, há ${shell.length}`);
  assert.deepEqual(shell[0], { action: "shell", resource: "*", effect: "allow" });
  for (const pattern of ["git push*", "git reset --hard*", "rm *", "sudo *", "npm uninstall*", "docker system prune*", "terraform destroy*"]) {
    assert.equal(effectOf(config, "shell", pattern), "ask", `${pattern} deve pedir aprovação`);
  }

  const manifest = await loadManifest(dir);
  assert.ok(manifest.files.length > 0);
  assert.ok(manifest.configAdded.length > 0);
  assert.ok(manifest.version);
  // Manifest v2: as entradas de config são identificadas por regra, não por
  // caminho de chave.
  assert.deepEqual(manifest.configAdded[0], {
    legacy: false,
    agent: null,
    action: "shell",
    resource: "*",
    effect: "allow"
  });
});

test("installGlobal é idempotente", async () => {
  const dir = tempDir();
  await installGlobal({ configDir: dir });
  const first = await loadManifest(dir);
  const result = await installGlobal({ configDir: dir });
  const second = await loadManifest(dir);
  assert.equal(result.copied, 0);
  assert.equal(result.merged, false);
  assert.equal(second.files.length, first.files.length);
  assert.equal(second.configAdded.length, first.configAdded.length);
});

test("installGlobal preserva arquivos e config pré-existentes do usuário", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "meu-agente.md"), "---\ndescription: meu\nmode: subagent\n---\ncorpo", "utf8");
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { chave: "valor" } }), "utf8");

  await installGlobal({ configDir: dir });

  assert.equal(readFileSync(join(dir, "agents", "meu-agente.md"), "utf8").includes("meu"), true);
  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(config.provider.chave, "valor");
  assert.equal(effectOf(config, "shell", "*"), "allow", "os nossos grants de shell foram acrescentados");
});

test("installGlobal --force sobrescreve arquivos existentes", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "intake.md"), "conteúdo antigo", "utf8");
  await installGlobal({ configDir: dir, force: true });
  assert.match(readFileSync(join(dir, "agents", "intake.md"), "utf8"), /Intake/);
});

test("installGlobal --dry-run não escreve nada", async () => {
  const dir = tempDir();
  const result = await installGlobal({ configDir: dir, dryRun: true });
  assert.ok(result.copied > 0, "dry-run deve reportar o que seria copiado");
  assert.ok(!existsSync(join(dir, "agents")));
  assert.ok(!existsSync(join(dir, MANIFEST_FILE)));
  assert.ok(!existsSync(join(dir, "opencode.json")));
});

test("installGlobal remove entradas stale de agentes e registra configRemoved", async () => {
  const dir = tempDir();
  // Config V1 com um agente completo: o instalador embute agora os agentes em
  // .md, por isso uma entrada com chaves de assinatura é obsoleta.
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({
      agent: {
        implementer: {
          name: "implementer",
          description: "L2",
          mode: "subagent",
          prompt: "x",
          permission: { read: { ".loop-development/**": "allow" } },
        },
      },
    }),
    "utf8"
  );

  const result = await installGlobal({ configDir: dir });

  assert.ok(result.configRemoved.includes("agents.implementer"), "a entrada stale é removida sob o nome V2");
  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(config.agents?.implementer?.name, undefined);
  assert.ok(config.agent === undefined, "`agent` foi migrado para `agents`");
  const manifest = await loadManifest(dir);
  assert.ok(manifest.configRemoved.includes("agents.implementer"));
  assert.ok(existsSync(join(dir, "opencode.json.bak-loop-development")));
});

test("installGlobal com entry stale é idempotente", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ agent: { implementer: { name: "implementer", mode: "subagent", prompt: "x", permission: { bash: "ask" } } } }),
    "utf8"
  );
  await installGlobal({ configDir: dir });
  const result = await installGlobal({ configDir: dir });
  assert.equal(result.merged, false);
  assert.equal(result.configRemoved.length, 0);
});

test("installGlobal migra config antigo: remove shell per-agent e o artefacto agents.permission", async () => {
  const dir = tempDir();
  // Manifest v2: entradas com identidade de regra. Entradas no formato v1
  // ({ path, key }) são marcadas legacy e não casam com a limpeza — perda única e
  // inofensiva, aceite pelo plano (§4.3).
  writeFileSync(
    join(dir, MANIFEST_FILE),
    JSON.stringify({
      manifestVersion: 2,
      configAdded: [
        { agent: "implementer", action: "shell", resource: "*", effect: "allow" },
        { agent: "verifier", action: "shell", resource: "*", effect: "allow" },
      ],
    }),
    "utf8"
  );
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({
      agent: {
        implementer: { permission: { bash: "allow", read: { "x/**": "allow" } } },
        verifier: { permission: { bash: "allow" } },
        permission: { bash: "allow" },
      },
    }),
    "utf8"
  );

  const result = await installGlobal({ configDir: dir });

  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  // As regras por-agente obsoletas (bash/shell) saem; o resto do utilizador fica.
  assert.equal(
    hasRule(config, "shell", "*", "implementer"),
    false,
    "remove a regra shell per-agent do implementer",
  );
  assert.equal(hasRule(config, "shell", "*", "verifier"), false, "remove a regra shell per-agent do verifier");
  assert.equal(config.agents?.permission, undefined, "remove o artefacto inválido agents.permission");
  assert.equal(
    effectOf(config, "read", "x/**", "implementer"),
    "allow",
    "preserva a regra de leitura do utilizador",
  );
  // O `permission.bash` do utilizador migra para uma regra shell global — não é
  // gerida por nós, por isso não é removida. As regras obsoletas são só as
  // por-agente que o manifest registou como nossas.
  assert.equal(effectOf(config, "shell", "*"), "allow");
  assert.equal(config.permission, undefined, "a chave V1 `permission` desapareceu");
  assert.ok(
    result.configRemoved.includes("agent:implementer:shell|*"),
    "regra por-agente do implementer removida",
  );
  assert.ok(result.configRemoved.includes("agent:verifier:shell|*"), "regra por-agente do verifier removida");
  assert.ok(result.configRemoved.includes("agents.permission"));

  const manifest = await loadManifest(dir);
  assert.ok(manifest.configRemoved.includes("agent:implementer:shell|*"));
});

test("uninstall remove só o que foi instalado e preserva o resto", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "meu-agente.md"), "---\ndescription: meu\nmode: subagent\n---\ncorpo", "utf8");

  await installGlobal({ configDir: dir });
  await uninstall({ configDir: dir });

  assert.ok(!existsSync(join(dir, "agents", "loop-development.md")));
  assert.ok(!existsSync(join(dir, "commands", "loop-development.md")));
  assert.ok(!existsSync(join(dir, "templates", "AGENTS.md.template")));
  assert.ok(!existsSync(join(dir, "scripts", "set-model.sh")));
  assert.ok(existsSync(join(dir, "agents", "meu-agente.md")));

  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.ok(!rulesOf(config).some((r) => r.action === "shell"), "as regras geridas são removidas no uninstall");
  assert.ok(!existsSync(join(dir, MANIFEST_FILE)));
});

test("setModel altera os agentes instalados do tier", async () => {
  const dir = tempDir();
  await installGlobal({ configDir: dir });
  const changed = await setModel("mechanical", "opencode/gpt-5-nano", { configDir: dir });
  assert.ok(changed > 0);
  const intake = readFileSync(join(dir, "agents", "intake.md"), "utf8");
  assert.match(intake, /^model: opencode\/gpt-5-nano$/m);
});

test("setModel rejeita tier inválido", async () => {
  await assert.rejects(() => setModel("inexistente", "x/y", { configDir: tempDir() }), /Tier inválido/);
});

test("installProject cria .loop-development/ e AGENTS.md", async () => {
  const dir = tempDir();
  await installProject({ targetDir: dir });
  assert.ok(existsSync(join(dir, ".loop-development", "state.json")));
  assert.ok(existsSync(join(dir, "AGENTS.md")));
  assert.ok(!existsSync(join(dir, "AGENTS.md.template")));
});

test("installProject é idempotente", async () => {
  const dir = tempDir();
  await installProject({ targetDir: dir });
  const result = await installProject({ targetDir: dir });
  assert.equal(result.copied, 0);
  assert.equal(result.existed > 0, true);
  assert.equal(result.projectConfig.merged, false);
  assert.equal(result.projectConfig.added, 0);
});

// O plano §4.1 moveu o estado do session-title para `ctx.storage` (durável e
// scoped pelo plugin), pelo que a entrada `.loop-development/session-titles.json`
// deixou de ser necessária no .gitignore. Este teste fixa essa decisão: o
// installer só escreve as entradas de segredos (.env*).
test("installProject escreve apenas as entradas de segredos no .gitignore (aditivo e idempotente)", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");

  const result = await installProject({ targetDir: dir });
  assert.equal(result.gitignore, true);
  const first = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.ok(first.includes("node_modules/"), "conteúdo pré-existente preservado");
  assert.ok(
    !first.includes("session-titles.json"),
    "o estado do session-title vive em ctx.storage, não precisa de entrada no .gitignore",
  );

  const second = await installProject({ targetDir: dir });
  assert.equal(second.gitignore, false, "não duplica as entradas");
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), first);
});

test("installProject cria .gitignore quando o projeto não tem um", async () => {
  const dir = tempDir();
  await installProject({ targetDir: dir });
  const content = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.ok(content.includes(".env"));
  assert.ok(!content.includes("session-titles.json"), "sem a entrada removida em V2");
});

test("installProject garante .env* no .gitignore (M004)", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");

  await installProject({ targetDir: dir });
  const content = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.ok(content.includes(".env"), "ignora .env");
  assert.ok(content.includes(".env.*"), "ignora .env.*");
  assert.ok(content.includes("!*.env.example"), "permite versionar .env.example");
  assert.ok(content.includes("node_modules/"), "conteúdo pré-existente preservado");

  const before = content;
  await installProject({ targetDir: dir });
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), before, "idempotente");
});

test("installProject grava grants de acesso no opencode.json do projeto", async () => {
  const dir = tempDir();
  const result = await installProject({ targetDir: dir });

  assert.equal(result.projectConfig.merged, true);
  assert.ok(result.projectConfig.added >= 42, "todos os agentes com read+glob");

  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  for (const name of ["loop-development", "intake", "implementer", "state-manager", "git-manager"]) {
    assert.equal(effectOf(config, "read", "*", name), "allow", `${name}: read broad allow`);
    assert.equal(effectOf(config, "read", "*.env", name), "ask", `${name}: .env protegido`);
    assert.equal(effectOf(config, "read", "*.env.*", name), "ask", `${name}: .env.* protegido`);
    assert.equal(effectOf(config, "read", "*.env.example", name), "allow", `${name}: .env.example legível`);
    assert.equal(effectOf(config, "glob", "*", name), "allow", `${name}: glob broad allow`);
    // No V2 a ordem é significativa: o catch-all allow precede as excepções.
    const read = rulesOf(config, name).filter((r) => r.action === "read");
    assert.equal(read[0].resource, "*", `${name}: broad antes das excepções`);
  }
  for (const name of ["implementer", "test-writer", "refactorer", "documentation-writer"]) {
    assert.equal(effectOf(config, "edit", "*", name), "allow", `${name}: edit allow`);
    assert.equal(effectOf(config, "edit", "*.env", name), "ask", `${name}: edit .env protegido`);
  }
  for (const name of ["intake", "state-manager", "git-manager", "verifier"]) {
    assert.equal(hasRule(config, "edit", "*", name), false, `${name}: sem edit`);
  }
});

test("installProject é aditivo — não sobrepõe regras existentes do projeto", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ agent: { implementer: { permission: { read: { "*": "ask" } } } }, custom: 1 }),
    "utf8"
  );

  const result = await installProject({ targetDir: dir });

  assert.equal(result.projectConfig.merged, true);
  assert.ok(result.projectConfig.backup, "faz backup do config existente");
  assert.ok(existsSync(result.projectConfig.backup));
  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(effectOf(config, "read", "*", "implementer"), "ask", "regra do utilizador preservada");
  assert.equal(config.custom, 1, "resto do config preservado");
  assert.equal(effectOf(config, "read", "*", "intake"), "allow", "grants aplicados aos restantes");
});

test("installProject --dry-run não escreve o opencode.json do projeto", async () => {
  const dir = tempDir();
  await installProject({ targetDir: dir, dryRun: true });
  assert.ok(!existsSync(join(dir, "opencode.json")));
  assert.ok(!existsSync(join(dir, ".loop-development")));
  assert.ok(!existsSync(join(dir, ".gitignore")));
});

test("installProject com presets gera AGENTS.md preenchido", async () => {
  const dir = tempDir();
  const result = await installProject({ targetDir: dir, backend: "nestjs-prisma", frontend: "expo", pm: "pnpm" });
  assert.equal(result.presets, true);
  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.match(agents, /## Stack/);
  assert.match(agents, /## Comandos do projeto/);
  assert.match(agents, /NestJS 11 \(Express\) \+ Prisma 7/);
  assert.match(agents, /Expo SDK 55/);
  assert.match(agents, /- Dev \(backend\): pnpm start:dev/);
  assert.ok(existsSync(join(dir, ".loop-development", "state.json")));
  assert.ok(!existsSync(join(dir, "AGENTS.md.template")));
});

test("installProject rejeita preset desconhecido", async () => {
  await assert.rejects(() => installProject({ targetDir: tempDir(), backend: "x" }), /Preset de backend desconhecido: x/);
});

// ---------------------------------------------------------------------------
// M008 — regras da casa
// ---------------------------------------------------------------------------

test("installProject escreve o bloco de regras e dá leitura da raiz da skill", async () => {
  const { configDir, skillRoot } = await withSkill();
  const dir = tempDir();
  const result = await installProject({ targetDir: dir, backend: "nestjs-prisma", pm: "pnpm", configDir });

  assert.equal(result.rules.skillInstalled, true);
  assert.deepEqual(result.rules.missing, []);

  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.equal(hasRulesBlock(agents), true);
  assert.ok(agents.indexOf(RULES_START) > agents.indexOf("## Convenções"), "o delta vem primeiro, a herança depois");
  assert.match(agents, /references\/general\/security\.md/, "os universais entram no bloco");
  assert.match(agents, /references\/backend\/nestjs\.md/, "os módulos do preset também");
  assert.match(agents, /Precedência/, "a precedência fica explícita");

  // A skill vive FORA do projecto: sem external_directory o read não a alcança.
  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  const external = rulesOf(config).filter((r) => r.action === "external_directory");
  assert.equal(external.length, 2);
  assert.deepEqual(external.map((r) => r.effect), ["allow", "allow"]);
  assert.equal(external[0].resource, toPosix(skillRoot));
  assert.equal(external[1].resource, `${toPosix(skillRoot)}/**`);
});

test("installProject sem skill instalada escreve o bloco em modo avisado", async () => {
  const dir = tempDir();
  const result = await installProject({ targetDir: dir, backend: "express", pm: "npm", configDir: tempDir() });

  assert.equal(result.rules.skillInstalled, false);
  assert.deepEqual(result.rules.missing, ["backend/express-fastify"]);

  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.equal(hasRulesBlock(agents), true, "o bloco escreve-se sempre, para o gain não depender da instalação");
  assert.match(agents, /ainda não está instalada/);

  const config = parseConfig(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(rulesOf(config).filter((r) => r.action === "external_directory").length, 0);
});

test("installProject não toca num AGENTS.md do utilizador sem marcadores", async () => {
  const { configDir } = await withSkill();
  const dir = tempDir();
  const original = "# As minhas regras\n\n- código em inglês\n";
  writeFileSync(join(dir, "AGENTS.md"), original, "utf8");

  const messages = [];
  const result = await installProject({ targetDir: dir, backend: "express", pm: "npm", configDir, log: (m) => messages.push(m) });

  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), original, "o ficheiro fica intacto");
  assert.equal(result.rules.skillInstalled, true);
  assert.ok(messages.some((m) => m.includes("rules link")), "aponta o comando explícito");
});

test("installProject reescreve só o bloco quando os marcadores já existem", async () => {
  const { configDir } = await withSkill();
  const dir = tempDir();
  await installProject({ targetDir: dir, backend: "express", pm: "npm", configDir });
  const first = readFileSync(join(dir, "AGENTS.md"), "utf8");

  // Aponta a lista de módulos para um preset diferente.
  const second = await installProject({ targetDir: dir, backend: "nestjs-prisma", pm: "npm", configDir });
  const content = readFileSync(join(dir, "AGENTS.md"), "utf8");

  assert.equal(second.rules.skillInstalled, true);
  assert.notEqual(content, first, "o bloco foi actualizado");
  assert.equal((content.split(RULES_START).length - 1), 1, "não duplicou o bloco");
  assert.match(content, /references\/backend\/prisma\.md/);
  assert.match(content, /## Convenções/);
});

test("installProject é idempotente com o bloco de regras", async () => {
  const { configDir } = await withSkill();
  const dir = tempDir();
  await installProject({ targetDir: dir, backend: "express", pm: "npm", configDir });
  const before = readFileSync(join(dir, "AGENTS.md"), "utf8");

  const second = await installProject({ targetDir: dir, backend: "express", pm: "npm", configDir });
  assert.equal(second.copied, 0);
  assert.equal(second.existed > 0, true);
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), before);
  assert.equal(second.projectConfig.merged, false, "o grant de external_directory não é reinserido");
});

test("installProject usa o template em branco mas mesmo assim declara a herança", async () => {
  const { configDir } = await withSkill();
  const dir = tempDir();
  await installProject({ targetDir: dir, configDir });
  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.equal(hasRulesBlock(agents), true);
  assert.match(agents, /## Convenções/, "vem do template");
});
