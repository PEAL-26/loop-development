import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, cp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolveConfigDir } from "./config-dir.js";
import { mergeConfigFile } from "./merge-config.js";
import { loadManifest, saveManifest } from "./manifest.js";
import { buildAgentsMd, findPreset } from "./presets.js";

export const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const ASSETS_DIR = join(PKG_ROOT, "opencode");

const DIRS_TO_COPY = ["agents", "commands", "scripts", "templates"];

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

async function copyFileIfNeeded(src, dst, force) {
  if (!force && existsSync(dst)) return "exists";
  await mkdir(dirname(dst), { recursive: true });
  await cp(src, dst);
  return "copied";
}

async function writeFileIfNeeded(dst, content, force) {
  if (!force && existsSync(dst)) return "exists";
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, content, "utf8");
  return "copied";
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

  const files = [];
  const results = { copied: 0, existed: 0 };

  for (const sub of DIRS_TO_COPY) {
    const srcDir = join(ASSETS_DIR, sub);
    if (!existsSync(srcDir)) continue;
    for (const rel of await walk(srcDir)) {
      const relPath = join(sub, rel);
      files.push(relPath);
      const dst = join(dir, relPath);
      const status = dryRun
        ? !force && existsSync(dst) ? "exists" : "copied"
        : await copyFileIfNeeded(join(srcDir, rel), dst, force);
      if (status === "copied") {
        results.copied += 1;
        log(`copiado: ${relPath}`);
      } else {
        results.existed += 1;
      }
    }
  }

  const baseConfig = JSON.parse(await readFile(join(ASSETS_DIR, "opencode.json"), "utf8"));
  const mergeResult = await mergeConfigFile(dir, baseConfig, { dryRun });
  if (mergeResult.changed && !dryRun) {
    log(`config: ${mergeResult.backup ? `backup em ${mergeResult.backup}` : "criado"} — ${mergeResult.added.length} permissão(ões) adicionada(s)`);
  }

  const updatedManifest = {
    ...manifest,
    version: pkg.version,
    installedAt: manifest.installedAt ?? new Date().toISOString(),
    files: uniqueBy([...(manifest.files ?? []), ...files], (f) => f),
    configFile: mergeResult.file ?? manifest.configFile,
    configAdded: uniqueBy(
      [...(manifest.configAdded ?? []), ...mergeResult.added],
      (a) => `${a.path}.${a.key}`
    ),
    configManaged: uniqueBy(
      [...(manifest.configManaged ?? []), ...mergeResult.managed],
      (a) => `${a.path}.${a.key}`
    ),
    configRemoved: uniqueBy(
      [...(manifest.configRemoved ?? []), ...mergeResult.removed],
      (a) => a
    )
  };

  if (!dryRun) await saveManifest(dir, updatedManifest);

  log(`\nLoop Development instalado em ${dir}`);
  log(`Arquivos: ${results.copied} copiados, ${results.existed} já existiam`);
  log("Reinicia o OpenCode para que os agentes e comandos fiquem disponíveis.");
  if (dryRun) log("(--dry-run: nada foi alterado)");

  return { configDir: dir, copied: results.copied, existed: results.existed, merged: mergeResult.changed, configRemoved: mergeResult.removed, manifest: updatedManifest };
}

export async function installProject({ targetDir = process.cwd(), force = false, dryRun = false, log = () => {}, backend = null, frontend = null, pm = null } = {}) {
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
    ? !force && existsSync(join(targetDir, "AGENTS.md")) ? "exists" : "copied"
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
      ? !force && existsSync(dst) ? "exists" : "copied"
      : await copyFileIfNeeded(join(templatesDir, rel), dst, force);
    if (status === "copied") {
      results.copied += 1;
      log(`criado: ${rel}`);
    } else {
      results.existed += 1;
    }
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

  return { targetDir, copied: results.copied, existed: results.existed, presets: withPresets };
}
