import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolveConfigDir } from "./config-dir.js";
import { loadManifest, MANIFEST_FILE } from "./manifest.js";
import { findConfigFile, parseConfig, serializeConfig, readRules, writeRules, removeRule } from "./merge-config.js";

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
    return { removed: 0, configChanged: false, rulesRemoved: 0, legacySkipped: 0 };
  }

  const toRemoveFiles = [];
  for (const entry of manifest.files ?? []) {
    const rel = typeof entry === "string" ? entry : entry?.path;
    if (!rel) continue;
    if (existsSync(join(dir, rel))) toRemoveFiles.push(rel);
  }

  let configFile = manifest.configFile ?? findConfigFile(dir);
  let configChanged = false;
  let rulesRemoved = 0;
  let legacySkipped = 0;
  if (configFile && existsSync(configFile)) {
    const config = parseConfig(await readFile(configFile, "utf8"));
    const before = serializeConfig(config);
    for (const entry of manifest.configAdded ?? []) {
      // Entradas do manifest v1 identificavam permissões por caminho de chave e
      // não correspondem a nenhuma regra V2. São saltadas em vez de removidas às
      // cegas (ver normalizeConfigEntry no manifest.js).
      if (entry?.legacy) {
        legacySkipped += 1;
        continue;
      }
      const scope = { agent: entry.agent ?? null };
      const result = removeRule(readRules(config, scope), {
        action: entry.action,
        resource: entry.resource,
        effect: entry.effect,
      });
      if (!result.removed) continue;
      writeRules(config, scope, result.rules);
      rulesRemoved += 1;
    }
    configChanged = serializeConfig(config) !== before;

    if (!dryRun && configChanged) {
      const backup = backupPath(configFile);
      await rename(configFile, backup);
      await writeFile(configFile, serializeConfig(config), "utf8");
      log(`config: backup em ${backup}`);
    }
  }

  log(`Removendo de ${dir}:`);
  for (const rel of toRemoveFiles) log(`  - ${rel}`);
  if (rulesRemoved > 0) log(`  - ${rulesRemoved} regra(s) de permissão adicionada(s)`);
  if (legacySkipped > 0) {
    log(
      `  - ${legacySkipped} entrada(s) de config em formato v1 não removidas automaticamente (o backup do config preserva-as)`,
    );
  }

  if (!dryRun) {
    for (const rel of toRemoveFiles) await rm(join(dir, rel), { force: true });
    await rm(join(dir, MANIFEST_FILE), { force: true });
  }

  log(dryRun ? "\n(--dry-run: nada foi alterado)" : "\nLoop Development removido. Reinicia o OpenCode.");
  return { removed: toRemoveFiles.length, configChanged, rulesRemoved, legacySkipped };
}