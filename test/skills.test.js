import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SKILLS_REPO_URL,
  SKILLS_DEFAULT_REF,
  SKILL_NAME,
  DEFAULT_ALWAYS_ON,
  SkillsError,
  resolveRepo,
  resolveRef,
  parseRepoUrl,
  codeloadUrl,
  commitApiUrl,
  assertSafeRef,
  displayPath,
  skillDir,
  skillRootDir,
  readRegistry,
  expandModules,
  inspectSkill,
  ensureSkills,
  updateSkills,
  removeSkills,
  listSkills,
  skillsStatus,
  printSkillPath,
} from "../src/skills.js";
import { loadManifest } from "../src/manifest.js";
import { gunzip } from "../src/tar.js";
import { makeRepoTarball, makeTarball, fakeFetch } from "./helpers/tar.js";

const REPO = "https://github.com/PEAL-26/peal-skills";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-skills-"));
}

function sampleEntries() {
  return [
    { name: "README.md", data: "# repo" },
    { name: "project-rules/SKILL.md", data: "---\nname: project-rules\n---\norquestrador" },
    { name: "project-rules/references/general/security.md", data: "# 5 pilares" },
    { name: "project-rules/references/general/coding-standards.md", data: "# tipagem" },
    { name: "project-rules/references/backend/nestjs.md", data: "# nestjs" },
    { name: "project-rules/templates/BACKEND-NESTJS-AGENTS.md", data: "template" },
  ];
}

function installRoutes(extra = []) {
  return {
    "codeload.github.com": { body: makeRepoTarball("peal-skills-main", sampleEntries(), extra) },
    "api.github.com/repos": { body: JSON.stringify({ sha: "8d966619ced9f4f9fc132c682bbced22c1aa49bb" }) },
  };
}

function noNetwork() {
  return async () => {
    throw new Error("a rede não devia ser usada neste teste");
  };
}

// ---------------------------------------------------------------------------
// URL / configuração
// ---------------------------------------------------------------------------

test("as constantes públicas são as acordadas", () => {
  assert.equal(SKILLS_REPO_URL, REPO);
  assert.equal(SKILLS_DEFAULT_REF, "main");
  assert.equal(SKILL_NAME, "project-rules");
  assert.deepEqual(DEFAULT_ALWAYS_ON, ["general"]);
});

test("resolveRepo/resolveRef: flag > env > default", () => {
  const savedRepo = process.env.LOOP_DEVELOPMENT_SKILLS_REPO;
  const savedRef = process.env.LOOP_DEVELOPMENT_SKILLS_REF;
  delete process.env.LOOP_DEVELOPMENT_SKILLS_REPO;
  delete process.env.LOOP_DEVELOPMENT_SKILLS_REF;
  assert.equal(resolveRepo(null), REPO);
  assert.equal(resolveRepo("https://github.com/a/b"), "https://github.com/a/b");
  process.env.LOOP_DEVELOPMENT_SKILLS_REPO = "https://github.com/env/repo";
  process.env.LOOP_DEVELOPMENT_SKILLS_REF = "v1.2.3";
  assert.equal(resolveRepo(null), "https://github.com/env/repo");
  assert.equal(resolveRepo("https://github.com/a/b"), "https://github.com/a/b", "a flag ganha ao env");
  assert.equal(resolveRef(null), "v1.2.3");
  if (savedRepo === undefined) delete process.env.LOOP_DEVELOPMENT_SKILLS_REPO;
  else process.env.LOOP_DEVELOPMENT_SKILLS_REPO = savedRepo;
  if (savedRef === undefined) delete process.env.LOOP_DEVELOPMENT_SKILLS_REF;
  else process.env.LOOP_DEVELOPMENT_SKILLS_REF = savedRef;
});

test("parseRepoUrl aceita https, ssh e .git", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/PEAL-26/peal-skills"), {
    host: "github.com",
    owner: "PEAL-26",
    name: "peal-skills",
  });
  assert.deepEqual(parseRepoUrl("https://github.com/PEAL-26/peal-skills.git"), {
    host: "github.com",
    owner: "PEAL-26",
    name: "peal-skills",
  });
  assert.deepEqual(parseRepoUrl("git@github.com:PEAL-26/peal-skills.git"), {
    host: "github.com",
    owner: "PEAL-26",
    name: "peal-skills",
  });
  assert.throws(() => parseRepoUrl("não é um url"), SkillsError);
});

test("codeloadUrl e commitApiUrl constroem os URLs do GitHub", () => {
  assert.equal(codeloadUrl(REPO, "main"), "https://codeload.github.com/PEAL-26/peal-skills/tar.gz/main");
  assert.equal(commitApiUrl(REPO, "main"), "https://api.github.com/repos/PEAL-26/peal-skills/commits/main");
  assert.throws(() => codeloadUrl("https://gitlab.com/a/b", "main"), /só é suportado GitHub/);
});

test("assertSafeRef recusa refs queInjectionariam o URL", () => {
  assert.equal(assertSafeRef("main"), "main");
  assert.equal(assertSafeRef("v1.2.3"), "v1.2.3");
  assert.equal(assertSafeRef("feature/nova"), "feature/nova");
  assert.throws(() => assertSafeRef("../../etc/passwd"), SkillsError);
  assert.throws(() => assertSafeRef("main?x=1"), SkillsError);
  assert.throws(() => assertSafeRef("a b"), SkillsError);
  assert.throws(() => assertSafeRef(""), SkillsError);
});

test("displayPath troca o home por ~ e preserva o resto", () => {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) return;
  assert.equal(displayPath(join(home, ".config", "opencode", "skills")), "~/.config/opencode/skills");
  assert.equal(displayPath("/opt/outro/lugar"), "/opt/outro/lugar");
});

test("skillDir/skillRootDir/skillDir aninhado no config-dir", () => {
  assert.equal(skillRootDir("/cfg"), join("/cfg", "skills"));
  assert.equal(skillDir("/cfg"), join("/cfg", "skills", "project-rules"));
});

// ---------------------------------------------------------------------------
// Registo
// ---------------------------------------------------------------------------

test("readRegistry lê skills.json quando existe", async () => {
  const tarball = makeRepoTarball(
    "peal-skills-main",
    sampleEntries(),
    [{ name: "skills.json", data: JSON.stringify({ skills: [{ name: "project-rules", path: "project-rules", alwaysOn: ["general", "backend"] }] }) }],
  );
  const registry = await readRegistry(await gunzip(tarball));
  assert.equal(registry.source, "skills.json");
  assert.deepEqual(registry.skills, [{ name: "project-rules", path: "project-rules", alwaysOn: ["general", "backend"] }]);
});

test("readRegistry faz scan por SKILL.md quando não há índice", async () => {
  const registry = await readRegistry(await gunzip(makeRepoTarball("peal-skills-main", sampleEntries())));
  assert.equal(registry.source, "scan");
  assert.deepEqual(registry.skills, [{ name: "project-rules", path: "project-rules", alwaysOn: ["general"] }]);
});

test("readRegistry ignora skills aninhadas e skills.json inválido", async () => {
  const nested = await readRegistry(
    await gunzip(makeRepoTarball("r", [{ name: "skills/um/SKILL.md", data: "---\nname: um\n---" }])),
  );
  assert.deepEqual(nested.skills, [], "apenas skills de primeiro nível");

  const broken = await gunzip(makeRepoTarball("r", [], [{ name: "skills.json", data: "{isto não é json" }]));
  await assert.rejects(() => readRegistry(broken), /skills\.json inválido/);
});

// ---------------------------------------------------------------------------
// Módulos
// ---------------------------------------------------------------------------

function fixtureSkill(location) {
  mkdirSync(join(location, "references", "general"), { recursive: true });
  mkdirSync(join(location, "references", "backend"), { recursive: true });
  writeFileSync(join(location, "SKILL.md"), "x", "utf8");
  writeFileSync(join(location, "references", "general", "security.md"), "# 5 pilares", "utf8");
  writeFileSync(join(location, "references", "backend", "nestjs.md"), "# nestjs", "utf8");
  return location;
}

test("expandModules expande pastas, ficheiros e omite o que não existe", async () => {
  const location = fixtureSkill(skillDir(tempDir(), SKILL_NAME));

  const { modules, missing } = await expandModules(location, [
    "general",
    "backend/nestjs",
    "references/general/security.md",
    "backend/inexistente",
  ]);
  assert.deepEqual(modules, ["references/backend/nestjs.md", "references/general/security.md"]);
  assert.deepEqual(missing, ["backend/inexistente"]);

  // Sem skill instalada não pode resolver nada.
  const none = await expandModules(null, ["general"]);
  assert.deepEqual(none.modules, []);
  assert.deepEqual(none.missing, ["general"]);
});

test("expandModules é idempotente e ignora specs vazios", async () => {
  const location = fixtureSkill(skillDir(tempDir(), SKILL_NAME));
  const a = await expandModules(location, ["general", "general", "", "   "]);
  const b = await expandModules(location, ["general"]);
  assert.deepEqual(a.modules, b.modules);
  assert.deepEqual(a.modules, ["references/general/security.md"]);
});

// ---------------------------------------------------------------------------
// ensure
// ---------------------------------------------------------------------------

test("ensureSkills instala a skill e grava a entrada no manifesto", async () => {
  const dir = tempDir();
  const result = await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) });

  assert.equal(result.changed, true);
  assert.equal(result.network, true);
  assert.equal(result.failed, false);
  assert.equal(result.entry.requestedRef, "main");
  assert.equal(result.entry.repo, REPO);
  assert.equal(result.entry.commitSha, "8d966619ced9f4f9fc132c682bbced22c1aa49bb");
  assert.ok(result.entry.contentSha256);
  assert.equal(result.entry.registrySource, "scan");

  const manifest = await loadManifest(dir);
  assert.ok(manifest.skills[SKILL_NAME], "a skill fica registada no manifesto");
  assert.equal(manifest.manifestVersion, 2, "o manifesto continua em v2");

  assert.equal(existsSync(join(skillDir(dir), "SKILL.md")), true);
  assert.equal(existsSync(join(skillDir(dir), "references", "general", "security.md")), true);
  assert.equal(existsSync(join(skillDir(dir), "templates")), true);
  assert.equal(existsSync(join(dir, "skills", "project-rules", "README.md")), false, "o README do repo não é extraído");
});

test("ensureSkills é idempotente: o segundo ensure não toca na rede", async () => {
  const dir = tempDir();
  await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) });

  const calls = [];
  const second = await ensureSkills({ configDir: dir, fetchImpl: fakeFetch({}, { onCall: (u) => calls.push(u) }) });
  assert.equal(second.changed, false);
  assert.equal(second.network, false);
  assert.deepEqual(calls, [], "nenhum request foi feito");
});

test("ensureSkills repara um ficheiro editado localmente", async () => {
  const dir = tempDir();
  await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) });
  writeFileSync(join(skillDir(dir), "SKILL.md"), "adulterado", "utf8");

  const broken = await inspectSkill({ configDir: dir });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.modified, ["SKILL.md"]);

  const repaired = await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) });
  assert.equal(repaired.changed, true);
  assert.match(readFileSync(join(skillDir(dir), "SKILL.md"), "utf8"), /name: project-rules/);
});

test("ensureSkills repara um ficheiro em falta", async () => {
  const dir = tempDir();
  await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) });
  const missing = join(skillDir(dir), "references", "general", "security.md");
  rmSync(missing, { force: true });

  const state = await inspectSkill({ configDir: dir });
  assert.equal(state.ok, false);
  assert.deepEqual(state.missing, ["references/general/security.md"]);
  assert.equal((await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) })).changed, true);
});

test("ensureSkills degrada em falha de rede sem lançar", async () => {
  const dir = tempDir();
  const messages = [];
  const result = await ensureSkills({
    configDir: dir,
    fetchImpl: async () => new Response("nope", { status: 500, statusText: "Server Error" }),
    log: (m) => messages.push(m),
  });
  assert.equal(result.failed, true);
  assert.equal(result.changed, false);
  assert.ok(messages.some((m) => /a seguir sem as regras da casa/.test(m)));
  assert.equal(existsSync(join(skillDir(dir), "SKILL.md")), false);
  assert.deepEqual((await loadManifest(dir)).skills, {}, "não escreve nada no manifesto quando falha");
});

test("ensureSkills com --dry-run não escreve", async () => {
  const dir = tempDir();
  const result = await ensureSkills({ configDir: dir, dryRun: true, fetchImpl: fakeFetch(installRoutes()) });
  assert.equal(result.changed, true);
  assert.equal(existsSync(join(skillDir(dir))), false);
  assert.deepEqual((await loadManifest(dir)).skills, {});
});

test("updateSkills força a re-download e guarda backup do anterior", async () => {
  const dir = tempDir();
  await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) });
  const result = await updateSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) });

  assert.equal(result.changed, true);
  assert.equal(existsSync(join(`${skillDir(dir)}.bak-loop-development`)), true);
  assert.equal(existsSync(join(skillDir(dir), "SKILL.md")), true);
});

test("ensureSkills degrada quando o tarball não traz a skill, sem deitar abaixo a instalação existente", async () => {
  const dir = tempDir();
  const good = fakeFetch(installRoutes());
  await ensureSkills({ configDir: dir, fetchImpl: good });
  const installed = readFileSync(join(skillDir(dir), "SKILL.md"), "utf8");

  // O repo mudou de estrutura: o tarball já não traz a subpasta.
  const broken = await ensureSkills({
    configDir: dir,
    force: true,
    fetchImpl: fakeFetch({ "codeload.github.com": { body: makeRepoTarball("r", [{ name: "README.md", data: "#" }]) } }),
    log: () => {},
  });
  assert.equal(broken.failed, true);
  assert.equal(broken.changed, false);
  assert.equal(readFileSync(join(skillDir(dir), "SKILL.md"), "utf8"), installed, "a instalação anterior ficou intacta");
  assert.equal(existsSync(`${skillDir(dir)}.staging-`), false, "nenhum staging ficou por limpar");
  assert.deepEqual(readdirSync(join(skillDir(dir))).sort().join(","), "SKILL.md,references,templates");
});

test("ensureSkills propaga refs inválidas em vez de as silenciar", async () => {
  await assert.rejects(() => ensureSkills({ configDir: tempDir(), ref: "../../etc", fetchImpl: noNetwork() }), SkillsError);
  await assert.rejects(() => ensureSkills({ configDir: tempDir(), repo: "não é um url", fetchImpl: noNetwork() }), SkillsError);
});

// ---------------------------------------------------------------------------
// estado / listagem / remoção
// ---------------------------------------------------------------------------

test("inspectSkill reporta não instalada antes da primeira instalação", async () => {
  const state = await inspectSkill({ configDir: tempDir() });
  assert.equal(state.installed, false);
  assert.equal(state.entry, null);
  assert.equal(state.ok, false);
});

test("listSkills e skillsStatus descrevem a skill instalada", async () => {
  const dir = tempDir();
  await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) });

  const listed = [];
  const result = await listSkills({ configDir: dir, log: (m) => listed.push(m) });
  assert.deepEqual(result.modules, ["references/general/coding-standards.md", "references/general/security.md"]);
  assert.ok(listed.some((l) => l.includes("sempre aplicáveis (2)")));

  const lines = [];
  const status = await skillsStatus({ configDir: dir, log: (m) => lines.push(m) });
  assert.equal(status.ok, true);
  assert.ok(lines.some((l) => l.includes("íntegra")));
});

test("skillsStatus e listSkills dizem o que fazer quando falta", async () => {
  const dir = tempDir();
  const lines = [];
  const status = await skillsStatus({ configDir: dir, log: (m) => lines.push(m) });
  assert.equal(status.ok, false);
  assert.ok(lines.some((l) => l.includes("skills ensure")));

  const listed = [];
  await listSkills({ configDir: dir, log: (m) => listed.push(m) });
  assert.ok(listed.some((l) => l.includes("não instalada")));
});

test("skillsStatus aponta ficheiros em falta ou editados", async () => {
  const dir = tempDir();
  await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) });
  writeFileSync(join(skillDir(dir), "SKILL.md"), "adulterado", "utf8");

  const lines = [];
  await skillsStatus({ configDir: dir, log: (m) => lines.push(m) });
  assert.ok(lines.some((l) => /1 ficheiro\(s\) editados localmente/.test(l)));
  assert.ok(lines.some((l) => l.includes("skills update")));
});

test("removeSkills apaga a pasta e a entrada do manifesto", async () => {
  const dir = tempDir();
  await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(installRoutes()) });

  const result = await removeSkills({ configDir: dir, log: () => {} });
  assert.equal(result.removed, true);
  assert.equal(existsSync(join(skillDir(dir))), false);
  assert.deepEqual((await loadManifest(dir)).skills, {});
});

test("removeSkills é seguro quando a skill não está registada", async () => {
  const dir = tempDir();
  assert.equal((await removeSkills({ configDir: dir, log: () => {} })).removed, false);
});

test("printSkillPath devolve a raiz canónica", () => {
  const lines = [];
  const location = printSkillPath({ configDir: "/cfg", log: (m) => lines.push(m) });
  assert.equal(location, join("/cfg", "skills", "project-rules"));
  assert.deepEqual(lines, ["/cfg/skills/project-rules"], "o path impresso usa separadores POSIX");
});

test("o conteúdo extraído corresponde byte a byte ao tarball", async () => {
  const dir = tempDir();
  const routes = installRoutes();
  await ensureSkills({ configDir: dir, fetchImpl: fakeFetch(routes) });

  const plain = await gunzip(routes["codeload.github.com"].body);
  const expected = plain.toString("utf8").includes("orquestrador");
  assert.equal(expected, true);
  assert.match(readFileSync(join(skillDir(dir), "SKILL.md"), "utf8"), /orquestrador/);
  assert.equal(readdirSync(join(skillDir(dir), "references", "backend")).sort().join(","), "nestjs.md");
});

test("um tarball sem gzip não parte a instalação", async () => {
  const dir = tempDir();
  const result = await ensureSkills({
    configDir: dir,
    fetchImpl: fakeFetch({ "codeload.github.com": { body: makeTarball([]).subarray(0, 10) } }),
    log: () => {},
  });
  assert.equal(result.failed, true, "um tarball corrompido degrada, não rebenta");
  assert.equal(existsSync(join(skillDir(dir))), false);
});
