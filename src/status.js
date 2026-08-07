import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveConfigDir } from "./config-dir.js";
import { loadManifest } from "./manifest.js";
import { findConfigFile, parseConfig, getPath } from "./merge-config.js";
import { readPackageJson } from "./install.js";
import { countMdFiles } from "./util.js";

export async function getStatus({ configDir } = {}) {
  const dir = resolveConfigDir(configDir);
  const manifest = await loadManifest(dir);
  const pkg = await readPackageJson();

  const agentsDir = join(dir, "agents");
  const commandsDir = join(dir, "commands");
  const agents = existsSync(agentsDir) ? await countMdFiles(agentsDir) : 0;
  const commands = existsSync(commandsDir) ? await countMdFiles(commandsDir) : 0;

  const configFile = findConfigFile(dir);
  let configEntries = null;
  if (existsSync(configFile)) {
    try {
      const config = parseConfig(await readFile(configFile, "utf8"));
      const task = getPath(config, "agent.loop-development.permission.task");
      configEntries = task ? Object.keys(task).length : 0;
    } catch {
      configEntries = "erro de leitura";
    }
  }

  const stateFile = join(process.cwd(), ".loop-development", "state.json");
  let projectPhase = null;
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      projectPhase = state.phase ?? "desconhecida";
    } catch {
      projectPhase = "erro de leitura";
    }
  }

  return { configDir: dir, packageVersion: pkg.version, installedVersion: manifest.version, agents, commands, configEntries, projectPhase, manifestExists: (manifest.files?.length ?? 0) > 0 };
}

export async function status(opts) {
  const data = await getStatus(opts);
  const lines = [];
  lines.push(`Diretório de config: ${data.configDir}`);
  lines.push(`Versão do pacote: ${data.packageVersion}${data.installedVersion ? ` (instalada: ${data.installedVersion})` : " — não instalado"}`);
  if (data.manifestExists) {
    lines.push(`Agentes instalados: ${data.agents}`);
    lines.push(`Comandos instalados: ${data.commands}`);
    lines.push(`Entradas no config: ${data.configEntries === null ? "nenhuma" : data.configEntries + " permissões de task"}`);
  } else {
    lines.push("Agentes instalados: nenhum (corre 'npx loop-development init')");
  }
  lines.push(`Projeto atual: ${data.projectPhase ? `fase "${data.projectPhase}"` : "sem .loop-development/ (corre 'npx loop-development init --project')"}`);
  (opts?.log ?? ((s) => console.log(s)))(lines.join("\n"));
  return data;
}
