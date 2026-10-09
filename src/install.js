import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, cp, readdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolveConfigDir } from "./config-dir.js";
import { mergeConfigFile, computeObsoleteCleanup } from "./merge-config.js";
import { loadManifest, saveManifest, ruleIdentity } from "./manifest.js";
import { buildAgentsMd, findPreset } from "./presets.js";
import { PROJECT_EDIT_AGENTS, PERMISSION_KEYS, projectGrantRules } from "./constants.js";
import { link } from "./link.js";

export const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const ASSETS_DIR = join(PKG_ROOT, "opencode");

const DIRS_TO_COPY = ["agents", "commands", "plugins", "scripts", "templates"];

export async function readPackageJson() {
  return JSON.parse(await readFile(join(PKG_ROOT, "package.json"), "utf8"));
}

async function walk(dir, rel = "") {
  const entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relPath = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) entries.push(...(await walk(join(dir, entry.name), relPath)));
    else entries.push(relPath);
  }
  return entries;
}

async function hashFile(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

// Decide o que fazer com um ficheiro já presente na pasta de config.
//
// A política é conservadora de propósito. O `update` sem --force só substitui um
// ficheiro quando consegue PROVAR que é uma versão nossa mais antiga (o hash
// instalado bate certo com o que embarcámos da última vez). Se o utilizador o
// tiver editado, não é tocado — sobrescrever um .md por iniciativa própria é
// pior do que pedir-lhe uma confirmação. O --force é o opt-in explícito, e faz
// backup do que substitui.
export function resolveFileAction({ exists, force, shippedSha, installedSha, previousSha }) {
  if (!exists) return "copy";
  if (shippedSha != null && shippedSha === installedSha) return "skip";
  if (force) return "refresh";
  if (installedSha == null) return "refresh";
  if (previousSha != null && previousSha === installedSha) return "refresh";
  return "modified";
}

async function backupFile(file) {
  const base = `${file}.bak-loop-development`;
  const target = existsSync(base) ? `${base}.${Date.now()}` : base;
  await rename(file, target);
  return target;
}

async function writeFileIfNeeded(dst, content, force) {
  if (!force && existsSync(dst)) return "exists";
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, content, "utf8");
  return "copied";
}

// Adiciona uma entrada ao .gitignore do projeto, só se ainda não existir.
// Cria o ficheiro se não houver. Respeita dryRun (reporta sem escrever).
async function ensureGitignoreEntry(targetDir, entry, { dryRun = false } = {}) {
  const file = join(targetDir, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = "";
  }
  const lines = existing.split(/\r?\n/);
  if (lines.some((l) => l.trim() === entry)) return { changed: false, file };
  if (dryRun) return { changed: true, file };
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await writeFile(file, `${existing}${prefix}${entry}\n`, "utf8");
  return { changed: true, file };
}

function uniqueBy(arr, fn) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = fn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function installGlobal({ configDir, force = false, dryRun = false, log = () => {} } = {}) {
  const dir = resolveConfigDir(configDir);
  await mkdir(dir, { recursive: true });
  const pkg = await readPackageJson();
  const manifest = await loadManifest(dir);

  const previousByPath = new Map((manifest.files ?? []).map((f) => [f.path, f]));
  const shippedEntries = new Map();
  const results = { copied: 0, skipped: 0, refreshed: 0, modified: [] };

  for (const sub of DIRS_TO_COPY) {
    const srcDir = join(ASSETS_DIR, sub);
    if (!existsSync(srcDir)) continue;
    for (const rel of await walk(srcDir)) {
      const relPath = join(sub, rel);
      const src = join(srcDir, rel);
      const dst = join(dir, relPath);
      const shippedSha = await hashFile(src);
      shippedEntries.set(relPath, { path: relPath, sha256: shippedSha, shippedIn: pkg.version });
      const installedSha = existsSync(dst) ? await hashFile(dst) : null;
      const action = resolveFileAction({
        exists: existsSync(dst),
        force,
        shippedSha,
        installedSha,
        previousSha: previousByPath.get(relPath)?.sha256 ?? null,
      });

      if (action === "skip") {
        results.skipped += 1;
        continue;
      }
      if (action === "modified") {
        results.modified.push(relPath);
        log(`inalterado (editado localmente): ${relPath}`);
        continue;
      }
      if (dryRun) {
        results.copied += 1;
        log(`(dry-run) ${action === "refresh" ? "actualizar" : "copiar"}: ${relPath}`);
        continue;
      }
      if (action === "refresh" && existsSync(dst)) {
        const backup = await backupFile(dst);
        log(`backup de ${relPath} em ${backup}`);
      }
      await mkdir(dirname(dst), { recursive: true });
      await cp(src, dst);
      results.copied += 1;
      log(`${action === "refresh" ? "actualizado" : "copiado"}: ${relPath}`);
    }
  }

  const baseConfig = JSON.parse(await readFile(join(ASSETS_DIR, "opencode.json"), "utf8"));
  const mergeResult = await mergeConfigFile(dir, baseConfig, {
    dryRun,
    mode: "managed",
    removeRules: computeObsoleteCleanup(manifest),
  });
  if (mergeResult.changed && !dryRun) {
    const details = [];
    if (mergeResult.added.length > 0) details.push(`${mergeResult.added.length} regra(s) adicionada(s)`);
    if (mergeResult.removed.length > 0) details.push(`${mergeResult.removed.length} entrada(s) obsoleta(s) removida(s)`);
    if (mergeResult.report.length > 0) details.push(`migração V1→V2: ${mergeResult.report.join("; ")}`);
    log(`config: ${mergeResult.backup ? `backup em ${mergeResult.backup}` : "criado"} — ${details.join(", ")}`);
  }
  for (const conflict of mergeResult.conflicts ?? []) {
    log(
      `conflito: a tua regra ${conflict.action} "${conflict.resource}" = ${conflict.kept} (${conflict.scope.agent ?? "global"}) foi mantida; a nossa seria ${conflict.ours}`,
    );
  }

  const updatedManifest = {
    ...manifest,
    manifestVersion: 2,
    version: pkg.version,
    installedAt: manifest.installedAt ?? new Date().toISOString(),
    files: mergeFileEntries(manifest, shippedEntries),
    configFile: mergeResult.file ?? manifest.configFile,
    configAdded: uniqueBy(
      [...(manifest.configAdded ?? []), ...mergeResult.added.map(toRuleEntry)],
      ruleIdentity,
    ),
    configConflicts: mergeResult.conflicts ?? [],
    configRemoved: uniqueBy([...(manifest.configRemoved ?? []), ...mergeResult.removed], (a) => a),
  };

  if (!dryRun) await saveManifest(dir, updatedManifest);

  log(`\nLoop Development instalado em ${dir}`);
  log(
    `Arquivos: ${results.copied} escritos, ${results.skipped} já actualizados` +
      (results.modified.length > 0 ? `, ${results.modified.length} inalterados por edição local` : ""),
  );
  if (results.modified.length > 0) {
    log(
      `Ficheiros editados localmente não foram sobrescritos. Para os substituir, corre 'loop-development update --force' (faz backup).`,
    );
  }
  log("Reinicia o OpenCode para que os agentes e comandos fiquem disponíveis.");
  if (dryRun) log("(--dry-run: nada foi alterado)");

  return {
    configDir: dir,
    copied: results.copied,
    skipped: results.skipped,
    modified: results.modified,
    merged: mergeResult.changed,
    configRemoved: mergeResult.removed,
    conflicts: mergeResult.conflicts ?? [],
    manifest: updatedManifest,
  };
}

function toRuleEntry(entry) {
  return {
    legacy: false,
    agent: entry.scope?.agent ?? null,
    action: entry.action,
    resource: entry.resource,
    effect: entry.effect,
  };
}

// Depois de instalar, o manifest guarda o hash do que foi EMBARCADO (não o que
// está em disco), para o próximo update poder distinguir "instalado por nós" de
// "editado pelo utilizador".
function mergeFileEntries(manifest, shippedEntries) {
  const entries = new Map();
  for (const entry of manifest.files ?? []) entries.set(entry.path, { ...entry });
  for (const [path, entry] of shippedEntries) entries.set(path, entry);
  return [...entries.values()];
}

export async function installProject({
  targetDir = process.cwd(),
  force = false,
  dryRun = false,
  log = () => {},
  backend = null,
  frontend = null,
  pm = null,
  noLink = false,
} = {}) {
  await mkdir(targetDir, { recursive: true });
  const templatesDir = join(ASSETS_DIR, "templates");
  const results = { copied: 0, existed: 0 };

  const withPresets = Boolean(backend || frontend);
  if (backend && !findPreset("backend", backend)) throw new Error(`Preset de backend desconhecido: ${backend}`);
  if (frontend && !findPreset("frontend", frontend)) throw new Error(`Preset de frontend desconhecido: ${frontend}`);

  const agentsContent = withPresets
    ? buildAgentsMd({ backend, frontend, pm })
    : await readFile(join(templatesDir, "AGENTS.md.template"), "utf8");

  const agentsStatus = dryRun
    ? !force && existsSync(join(targetDir, "AGENTS.md"))
      ? "exists"
      : "copied"
    : await writeFileIfNeeded(join(targetDir, "AGENTS.md"), agentsContent, force);
  if (agentsStatus === "copied") {
    results.copied += 1;
    log(`criado: AGENTS.md${withPresets ? ` (presets: ${[backend, frontend].filter(Boolean).join(" + ")})` : ""}`);
  } else {
    results.existed += 1;
  }

  for (const rel of await walk(templatesDir)) {
    if (rel === "AGENTS.md.template") continue;
    const dst = join(targetDir, rel);
    const status = dryRun
      ? !force && existsSync(dst)
        ? "exists"
        : "copied"
      : await copyFileIfNeeded(join(templatesDir, rel), dst, force);
    if (status === "copied") {
      results.copied += 1;
      log(`criado: ${rel}`);
    } else {
      results.existed += 1;
    }
  }

  // Grants de acesso ao projeto: regras aditivas de read/glob (allow) no
  // opencode.json da raiz, com as excepções .env, e edit apenas para os agentes
  // que escrevem ficheiros. Nunca sobrepõe uma regra que o utilizador já tenha.
  const projectGrants = buildProjectGrants();
  const configMerge = await mergeConfigFile(targetDir, projectGrants, { dryRun, mode: "project" });
  if (configMerge.changed && !dryRun) {
    const configInfo =
      configMerge.added.length > 0
        ? `${configMerge.added.length} regra(s) de acesso ao projeto adicionada(s)`
        : "grants de acesso ao projeto aplicados";
    log(`config: ${configMerge.backup ? `backup em ${configMerge.backup}` : "criado"} — ${configInfo}`);
  }

  // M004: ficheiros .env reais nunca devem ser versionados. Aditivo — apenas
  // preenche entradas em falta, sem sobrepor as regras do utilizador.
  // Nota: a antiga entrada `.loop-development/session-titles.json` deixou de ser
  // escrita — em V2 o estado do session-title vive em `ctx.storage`.
  let gitignore = false;
  for (const entry of [".env", ".env.*", "!*.env.example"]) {
    const status = await ensureGitignoreEntry(targetDir, entry, { dryRun });
    if (status.changed) gitignore = true;
    if (status.changed && !dryRun) {
      log(`.gitignore: adicionado ${entry} (segredos de ambiente nunca versionados)`);
    }
  }

  // M003: deteção e ligação automática da hierarquia main/child.
  if (!noLink) {
    const linkResult = await link({ projectDir: targetDir, dryRun, log });
    if (linkResult.parent) log(`ligado ao main: ${linkResult.parent.path}`);
    if (linkResult.parentCleared) log("ligação com um main anterior removida (main já não é válido)");
    if (linkResult.parentChildrenAdded) log(`registado no main: ${linkResult.parentChildrenAdded}`);
    if (linkResult.childrenAdded.length > 0) log(`children ligados: ${linkResult.childrenAdded.join(", ")}`);
  }

  log(`\nProjeto preparado em ${targetDir}`);
  log(`Arquivos: ${results.copied} criados, ${results.existed} já existiam`);
  if (withPresets) {
    log("AGENTS.md gerado a partir dos presets — revisa as secções e ajusta comandos reais se necessário.");
  } else {
    log("Edita o AGENTS.md com a stack, comandos reais (testes/lint/typecheck/build) e convenções do projeto.");
  }
  log("Para o estado persistente ser usado, garante que .loop-development/ existe na raiz do projeto.");
  log("Na primeira invocação do loop, o Intake cria a pasta do plano da funcionalidade em .loop-development/plans/.");

  return {
    targetDir,
    copied: results.copied,
    existed: results.existed,
    presets: withPresets,
    gitignore,
    projectConfig: { merged: configMerge.changed, added: configMerge.added.length, backup: configMerge.backup },
  };
}

async function copyFileIfNeeded(src, dst, force) {
  if (!force && existsSync(dst)) return "exists";
  await mkdir(dirname(dst), { recursive: true });
  await cp(src, dst);
  return "copied";
}

// Grants por agente como regras V2 ordenadas: "*" allow primeiro, excepções
// .env depois (no V2 vale a última regra que casa).
function buildProjectGrants() {
  const grants = { agents: {} };
  for (const name of listAgentNames()) {
    const rules = [];
    for (const action of PERMISSION_KEYS) {
      if (action === "edit" && !PROJECT_EDIT_AGENTS.includes(name)) continue;
      rules.push(...projectGrantRules(action));
    }
    grants.agents[name] = { permissions: rules };
  }
  return grants;
}

function listAgentNames() {
  const agentsDir = join(ASSETS_DIR, "agents");
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}