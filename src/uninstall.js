import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolveConfigDir } from "./config-dir.js";
import { loadManifest, MANIFEST_FILE } from "./manifest.js";
import { findConfigFile, parseConfig, serializeConfig, removeEntry } from "./merge-config.js";

function splitKey(entry) {
  const i = String(entry).lastIndexOf(".");
  return { path: entry.slice(0, i), key: entry.slice(i + 1) };
}

function backupPath(file) {
  const base = `${file}.bak-loop-development`;
  return existsSync(base) ? `${base}.${Date.now()}` : base;
}

export async function uninstall({ configDir, dryRun = false, log = () => {} } = {}) {
  const dir = resolveConfigDir(configDir);
  const manifest = await loadManifest(dir);
  const isInstalled = (manifest.files?.length ?? 0) > 0 || manifest.configFile;
  if (!isInstalled) {
    log(`Nada para remover: o Loop Development não está instalado em ${dir}.`);
    return { removed: 0, configChanged: false };
  }

  const toRemoveFiles = [];
  for (const rel of manifest.files ?? []) {
    const p = join(dir, rel);
    if (existsSync(p)) toRemoveFiles.push(rel);
  }

  let configFile = manifest.configFile ?? findConfigFile(dir);
  let config = null;
  let configChanged = false;
  if (configFile && existsSync(configFile)) {
    config = parseConfig(await readFile(configFile, "utf8"));
    const before = serializeConfig(config);
    for (const entry of manifest.configAdded ?? []) {
      const { path, key } = typeof entry === "string" ? splitKey(entry) : entry;
      if (path && key) removeEntry(config, path, key);
    }
    configChanged = serializeConfig(config) !== before;
  }

  log(`Removendo de ${dir}:`);
  for (const rel of toRemoveFiles) log(`  - ${rel}`);
  if (configChanged) log(`  - limpar entradas do loop-development em ${configFile}`);

  if (!dryRun) {
    for (const rel of toRemoveFiles) await rm(join(dir, rel), { force: true });
    if (configChanged && configFile) {
      const backup = backupPath(configFile);
      await rename(configFile, backup);
      await writeFile(configFile, serializeConfig(config), "utf8");
      log(`config: backup em ${backup}`);
    }
    await rm(join(dir, MANIFEST_FILE), { force: true });
  }

  log(dryRun ? "\n(--dry-run: nada foi alterado)" : "\nLoop Development removido. Reinicia o OpenCode.");
  return { removed: toRemoveFiles.length, configChanged };
}
