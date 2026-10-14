import { readFile, rename, rm, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { resolveConfigDir } from "./config-dir.js";
import { loadManifest, saveManifest } from "./manifest.js";
import { gunzip, parseTar, extractSubtree, detectRootDir, findEntry } from "./tar.js";

// ---------------------------------------------------------------------------
// Instalação das skills do registo `peal-skills`.
//
// A skill vive num repo git próprio e é descarregada a partir do codeload do
// GitHub (tarball por ref), não de um clone: o pacote não passa a depender do
// binário `git` nem a duplicar a fonte de verdade. O tarball traz o monorepo
// inteiro mas só extraímos a subpasta da skill.
//
// `ensure` garante que existe e está íntegra; `update` é que vai buscar a ref
// mais recente. `ensure` é local-first: com o manifesto em dia sai sem rede.
// ---------------------------------------------------------------------------

export const SKILLS_REPO_URL = "https://github.com/PEAL-26/peal-skills";
export const SKILLS_DEFAULT_REF = "main";
export const SKILL_NAME = "project-rules";
export const SKILL_PATH_IN_REPO = "project-rules";
export const DEFAULT_ALWAYS_ON = ["general"];
export const REFERENCES_DIR = "references";

export const FETCH_TIMEOUT_MS = 15000;
export const MAX_TARBALL_BYTES = 32 * 1024 * 1024;

export class SkillsError extends Error {}

export function resolveRepo(explicit = null) {
  return explicit ?? process.env.LOOP_DEVELOPMENT_SKILLS_REPO ?? SKILLS_REPO_URL;
}

export function resolveRef(explicit = null) {
  return explicit ?? process.env.LOOP_DEVELOPMENT_SKILLS_REF ?? SKILLS_DEFAULT_REF;
}

// A ref vai interpolada num URL. Validamos o alfabeto em vez de escapar, para
// não partir refs com "/" (branches do tipo `feature/x`).
export function assertSafeRef(ref) {
  if (typeof ref !== "string" || !/^[A-Za-z0-9._/-]{1,120}$/.test(ref) || ref.includes("..")) {
    throw new SkillsError(`ref inválida: "${ref}"`);
  }
  return ref;
}

export function parseRepoUrl(url) {
  const match = /^(?:https?:\/\/|git@)([^:/]+)[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  if (!match) throw new SkillsError(`URL de repo inválido: "${url}"`);
  return { host: match[1].toLowerCase(), owner: match[2], name: match[3] };
}

function assertGitHub(repo) {
  const { host, owner, name } = parseRepoUrl(repo);
  if (host !== "github.com") {
    throw new SkillsError(
      `só é suportado GitHub (codeload), não "${host}". Usa --skills-repo com um repo GitHub.`,
    );
  }
  return { owner, name };
}

export function codeloadUrl(repo, ref) {
  const { owner, name } = assertGitHub(repo);
  return `https://codeload.github.com/${owner}/${name}/tar.gz/${assertSafeRef(ref)}`;
}

export function commitApiUrl(repo, ref) {
  const { owner, name } = assertGitHub(repo);
  return `https://api.github.com/repos/${owner}/${name}/commits/${assertSafeRef(ref)}`;
}

export function skillRootDir(configDir) {
  return join(resolveConfigDir(configDir), "skills");
}

export function skillDir(configDir, name = SKILL_NAME) {
  return join(skillRootDir(configDir), name);
}

// Caminho com "~" no início e separadores POSIX — é o que vai para o AGENTS.md,
// que é versionado e lido em máquinas com separadores diferentes.
export function displayPath(absolute) {
  const home = homedir();
  const shortened = absolute.startsWith(home + sep) ? `~${absolute.slice(home.length)}` : absolute;
  return shortened.split(sep).join("/");
}

async function hashFile(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

async function collectMarkdown(dir, prefix = "") {
  const out = [];
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...(await collectMarkdown(join(dir, item.name), rel)));
    else if (item.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registo de skills
// ---------------------------------------------------------------------------

function frontmatterName(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return null;
  const name = /^name:\s*(.+)$/m.exec(match[1]);
  return name ? name[1].trim().replace(/^["']|["']$/g, "") : null;
}

// Lê o índice do repo (`skills.json`) se existir. Sem ele, varre as pastas que
// trazem um SKILL.md e lê o `name:` do frontmatter — que é o que a skill declara
// sobre si própria.
export async function readRegistry(tarBuffer) {
  const { entries } = parseTar(tarBuffer);
  const root = detectRootDir(entries.map((e) => e.name));
  const declared = findEntry(entries, `${root}/skills.json`);

  if (declared) {
    let parsed;
    try {
      parsed = JSON.parse(declared.data.toString("utf8"));
    } catch (err) {
      throw new SkillsError(`skills.json inválido no repo da skill: ${err.message}`);
    }
    const list = Array.isArray(parsed?.skills) ? parsed.skills : [];
    return {
      source: "skills.json",
      skills: list
        .filter((s) => s && typeof s.path === "string")
        .map((s) => ({
          name: typeof s.name === "string" && s.name !== "" ? s.name : s.path,
          path: s.path,
          alwaysOn: Array.isArray(s.alwaysOn) ? s.alwaysOn : DEFAULT_ALWAYS_ON,
        })),
    };
  }

  const found = [];
  for (const entry of entries) {
    const match = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(.+)/SKILL\\.md$`).exec(entry.name);
    if (!match) continue;
    const path = match[1];
    if (path.includes("/")) continue; // apenas skills de primeiro nível
    const name = frontmatterName(entry.data.toString("utf8")) ?? path;
    if (!found.some((s) => s.name === name)) found.push({ name, path, alwaysOn: DEFAULT_ALWAYS_ON });
  }
  return { source: "scan", skills: found };
}

// ---------------------------------------------------------------------------
// Módulos de regras
// ---------------------------------------------------------------------------

// Um spec é `"general"` (pasta) ou `"backend/nestjs"` (ficheiro, sem extensão).
// Devolve paths relativos à raiz da skill. Specs que não existam são omitidos —
// uma divergência de versão entre os dois repos nunca pode partir um projecto.
export async function expandModules(skillPath, specs) {
  // Sem skill instalada não há raiz: devolver vazio em vez de resolver
  // `references/...` relativo ao cwd, que poderia calhar com outra coisa.
  if (!skillPath) return { modules: [], missing: [...(specs ?? [])] };
  const references = join(skillPath, REFERENCES_DIR);
  const out = [];
  const missing = [];

  for (const raw of specs ?? []) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const spec = raw
      .trim()
      .replace(/^\.\//, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      // Aceitamos tanto "general" como "references/general": o formato canónico
      // é relativo a references/, mas quem editar o manifesto ou o bloco do
      // AGENTS.md vai naturalmente escrever o path completo.
      .replace(new RegExp(`^${REFERENCES_DIR}/`), "");
    if (spec === "") continue;

    // Pasta primeiro: `alwaysOn: ["general"]`. Depois ficheiro tal e qual, e
    // ficheiro com a extensão implícita: `rules: ["backend/nestjs"]`.
    const asDir = join(references, ...spec.split("/"));
    if (existsSync(asDir) && statSync(asDir).isDirectory()) {
      const nested = await collectMarkdown(asDir);
      if (nested.length === 0) {
        missing.push(raw);
        continue;
      }
      out.push(...nested.map((rel) => `${REFERENCES_DIR}/${spec}/${rel}`));
      continue;
    }

    const asFile = spec.endsWith(".md") ? spec : `${spec}.md`;
    if (existsSync(join(references, ...asFile.split("/")))) {
      out.push(`${REFERENCES_DIR}/${asFile}`);
      continue;
    }

    missing.push(raw);
  }

  return { modules: [...new Set(out)].sort(), missing: [...new Set(missing)] };
}

// ---------------------------------------------------------------------------
// Integridade
// ---------------------------------------------------------------------------

export async function inspectSkill({ configDir, name = SKILL_NAME } = {}) {
  const dir = resolveConfigDir(configDir);
  const manifest = await loadManifest(dir);
  const entry = manifest.skills?.[name] ?? null;
  const location = skillDir(dir, name);
  const skillFile = join(location, "SKILL.md");

  if (entry == null) {
    return { installed: false, entry: null, location, missing: [], modified: [], ok: false };
  }
  if (!existsSync(skillFile)) {
    return { installed: false, entry, location, missing: ["SKILL.md"], modified: [], ok: false };
  }

  const missing = [];
  const modified = [];
  for (const file of entry.files ?? []) {
    const target = join(location, ...file.path.split("/"));
    const current = await hashFile(target);
    if (current == null) missing.push(file.path);
    else if (current !== file.sha256) modified.push(file.path);
  }
  return { installed: true, entry, location, missing, modified, ok: missing.length === 0 && modified.length === 0 };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function download(url, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/vnd.github+json", "user-agent": "loop-development" },
    });
  } catch (err) {
    throw new SkillsError(`não foi possível descarregar ${url}: ${err.message}`);
  }
  if (!response.ok) {
    throw new SkillsError(`${url} respondeu ${response.status} ${response.statusText ?? ""}`.trim());
  }
  const declared = Number(response.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
    throw new SkillsError(`tarball de ${declared} bytes acima do limite (${MAX_TARBALL_BYTES})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_TARBALL_BYTES) {
    throw new SkillsError(`tarball de ${buffer.length} bytes acima do limite (${MAX_TARBALL_BYTES})`);
  }
  return buffer;
}

// Best-effort: um commit sha é bonito no `status`, mas falhar aqui não pode
// impedir a instalação.
async function resolveCommitSha(repo, ref, { fetchImpl, timeoutMs }) {
  try {
    const response = await fetchImpl(commitApiUrl(repo, ref), {
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
      headers: { accept: "application/vnd.github+json", "user-agent": "loop-development" },
    });
    if (!response.ok) return null;
    const json = await response.json();
    return typeof json?.sha === "string" ? json.sha : null;
  } catch {
    return null;
  }
}

// Move a instalação existente para `.bak-loop-development`. Quando não há nada
// instalado, não criamos o destino: o `rename` do staging é que o cria, e criar
// um directório vazio antes faria esse rename falhar com EPERM no Windows.
async function replaceDirectory(location) {
  if (!existsSync(location)) return null;
  const base = `${location}.bak-loop-development`;
  const target = existsSync(base) ? `${base}.${Date.now()}` : base;
  await rename(location, target);
  return target;
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

export async function ensureSkills({
  configDir,
  repo: repoArg = null,
  ref: refArg = null,
  name = SKILL_NAME,
  force = false,
  dryRun = false,
  quiet = false,
  log = () => {},
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  const dir = resolveConfigDir(configDir);
  const location = skillDir(dir, name);
  const say = (message) => {
    if (!quiet) log(message);
  };

  if (!force) {
    const current = await inspectSkill({ configDir: dir, name });
    if (current.ok) {
      return { changed: false, network: false, failed: false, entry: current.entry, location };
    }
  }

  const repo = resolveRepo(repoArg);
  const ref = resolveRef(refArg);

  // Validar ANTES do try: um typo em --skills-repo/--skills-ref é erro de
  // configuração e tem de ser alto. O catch de rede abaixo só existe para
  // degradação (sem internet, 404, tarball corrompido).
  const tarballUrl = codeloadUrl(repo, ref);

  let tarball;
  try {
    tarball = await download(tarballUrl, { fetchImpl, timeoutMs });
  } catch (err) {
    // Falha de rede é degradation, não erro: o loop continua sem as regras.
    say(`skill ${name}: ${err.message} — a seguir sem as regras da casa`);
    return { changed: false, network: true, failed: true, error: err.message, location, repo, ref };
  }

  const contentSha256 = createHash("sha256").update(tarball).digest("hex");

  if (dryRun) {
    say(`(dry-run) ${force ? "actualizar" : "instalar"} ${name} de ${repo}@${ref}`);
    return { changed: true, network: true, failed: false, location, repo, ref, contentSha256 };
  }

  // Extraímos para staging e só depois trocamos. Se o tarball vier gzip
  // corrompido ou com uma estrutura inesperada, a instalação que já existia
  // fica intacta — só depois de termos a certeza do que vamos escrever é que lhe
  // mexemos. Tudo o que vem do remoto é degradação, nunca erro.
  const staging = `${location}.staging-${Date.now()}`;
  let files;
  let warnings;
  let alwaysOn = DEFAULT_ALWAYS_ON;
  let registrySource = "scan";
  try {
    const plain = await gunzip(tarball);
    const registry = await readRegistry(plain);
    const declared = registry.skills.find((s) => s.name === name);
    const extracted = await extractSubtree(plain, { subpath: declared?.path ?? SKILL_PATH_IN_REPO, destDir: staging });
    files = extracted.files;
    warnings = extracted.warnings;
    alwaysOn = declared?.alwaysOn ?? DEFAULT_ALWAYS_ON;
    registrySource = registry.source;
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    say(`skill ${name}: ${err.message} — a seguir sem as regras da casa`);
    return { changed: false, network: true, failed: true, error: err.message, location, repo, ref };
  }

  const backup = await replaceDirectory(location);
  if (backup) say(`backup de ${displayPath(location)} em ${displayPath(backup)}`);
  await rename(staging, location);
  for (const warning of warnings) say(`  aviso: ${warning}`);

  const commitSha = await resolveCommitSha(repo, ref, { fetchImpl, timeoutMs });
  const { modules } = await expandModules(location, alwaysOn);

  const manifest = await loadManifest(dir);
  const entry = {
    repo,
    requestedRef: ref,
    contentSha256,
    commitSha,
    path: displayPath(location),
    installedAt: new Date().toISOString(),
    alwaysOn,
    registrySource,
    modules,
    files,
  };
  await saveManifest(dir, { ...manifest, skills: { ...(manifest.skills ?? {}), [name]: entry } });

  const source = commitSha ? `, ${commitSha.slice(0, 7)}` : "";
  say(`skill ${name} instalada em ${displayPath(location)} (${repo}@${ref}${source}, ${files.length} ficheiros)`);

  return { changed: true, network: true, failed: false, entry, location, repo, ref, contentSha256 };
}

export async function updateSkills(options = {}) {
  return ensureSkills({ ...options, force: true });
}

export async function removeSkills({ configDir, name = SKILL_NAME, dryRun = false, log = () => {} } = {}) {
  const dir = resolveConfigDir(configDir);
  const manifest = await loadManifest(dir);
  const entry = manifest.skills?.[name] ?? null;
  const location = skillDir(dir, name);
  if (entry == null) {
    log(`${name}: não está registada em ${displayPath(location)}`);
    return { removed: false, location };
  }
  if (existsSync(location)) {
    log(`${dryRun ? "(dry-run) remover" : "a remover"}: ${displayPath(location)}`);
    if (!dryRun) await rm(location, { recursive: true, force: true });
  }
  if (!dryRun) {
    const skills = { ...(manifest.skills ?? {}) };
    delete skills[name];
    await saveManifest(dir, { ...manifest, skills });
  }
  return { removed: true, location };
}

export async function listSkills({ configDir, name = SKILL_NAME, log = () => {} } = {}) {
  const dir = resolveConfigDir(configDir);
  const manifest = await loadManifest(dir);
  const entry = manifest.skills?.[name] ?? null;
  const location = skillDir(dir, name);

  if (entry == null) {
    log(`${name}: não instalada`);
    return { entry: null, modules: [] };
  }

  log(`${name}  ${entry.repo}@${entry.requestedRef}${entry.commitSha ? ` (${entry.commitSha.slice(0, 7)})` : ""}`);
  log(`  raiz: ${entry.path ?? displayPath(location)}`);
  log(`  registo: ${entry.registrySource ?? "desconhecido"} · contentSha256 ${(entry.contentSha256 ?? "").slice(0, 12)}`);
  log(`  ficheiros: ${(entry.files ?? []).length}`);
  const { modules } = await expandModules(location, entry.alwaysOn ?? DEFAULT_ALWAYS_ON);
  log(`  sempre aplicáveis (${modules.length}):`);
  for (const module of modules) log(`    - ${module}`);
  return { entry, modules };
}

export async function skillsStatus({ configDir, name = SKILL_NAME, log = () => {} } = {}) {
  const dir = resolveConfigDir(configDir);
  const current = await inspectSkill({ configDir: dir, name });

  if (current.entry == null) {
    log(`${name}: não instalada — corre 'loop-development skills ensure'`);
    return { ok: false, installed: false, missing: [], modified: [] };
  }

  const label =
    current.ok && current.modified.length === 0 && current.missing.length === 0
      ? "íntegra"
      : current.missing.length > 0
        ? `${current.missing.length} ficheiro(s) em falta`
        : `${current.modified.length} ficheiro(s) editados localmente`;

  log(`${name}: ${current.entry.repo}@${current.entry.requestedRef}${current.entry.commitSha ? ` (${current.entry.commitSha.slice(0, 7)})` : ""}`);
  log(`  raiz: ${current.entry.path ?? displayPath(current.location)}`);
  log(`  estado: ${label}`);
  if (current.modified.length > 0) log(`  editados: ${current.modified.slice(0, 5).join(", ")}${current.modified.length > 5 ? " …" : ""}`);
  if (!current.ok) log("  corre 'loop-development skills update' para repôr a versão do repo");

  return current;
}

export function printSkillPath({ configDir, name = SKILL_NAME, log = () => {} } = {}) {
  const location = skillDir(resolveConfigDir(configDir), name);
  log(displayPath(location));
  return location;
}

// Usado pelo installProject: onde fica a raiz da skill que os agentes vão ler.
export async function skillRootForProject({ configDir, name = SKILL_NAME } = {}) {
  const location = skillDir(resolveConfigDir(configDir), name);
  return existsSync(join(location, "SKILL.md")) ? location : null;
}
