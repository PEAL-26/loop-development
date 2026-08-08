import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveConfigDir } from "./config-dir.js";
import { loadManifest } from "./manifest.js";
import { findConfigFile, parseConfig, getPath } from "./merge-config.js";
import { readPackageJson } from "./install.js";
import { countMdFiles } from "./util.js";

export async function getStatus({ configDir, projectDir = process.cwd() } = {}) {
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
      const hasManaged = (manifest.configAdded?.length ?? 0) + (manifest.configManaged?.length ?? 0) > 0;
      configEntries = hasManaged
        ? (manifest.configAdded?.length ?? 0) + (manifest.configManaged?.length ?? 0)
        : task ? Object.keys(task).length : 0;
    } catch {
      configEntries = "erro de leitura";
    }
  }

  const stateFile = join(projectDir, ".loop-development", "state.json");
  let projectState = null;
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      projectState = {
        activePlan: state.active_plan ?? null,
        plans: Array.isArray(state.plans) ? state.plans : [],
        minCoverage: state.min_coverage ?? null,
        version: state.version ?? null,
      };
    } catch {
      projectState = "erro de leitura";
    }
  }

  let activePlanState = null;
  if (projectState && projectState !== "erro de leitura" && projectState.activePlan) {
    const planStateFile = join(projectDir, ".loop-development", "plans", projectState.activePlan, "state.json");
    if (existsSync(planStateFile)) {
      try {
        const s = JSON.parse(await readFile(planStateFile, "utf8"));
        activePlanState = {
          phase: s.phase ?? "desconhecida",
          currentTask: s.current_task ?? null,
          tasksDone: Array.isArray(s.tasks_done) ? s.tasks_done.length : 0,
          tasksPending: Array.isArray(s.tasks_pending) ? s.tasks_pending.length : 0,
        };
      } catch {
        activePlanState = "erro de leitura";
      }
    }
  }

  return { configDir: dir, packageVersion: pkg.version, installedVersion: manifest.version, agents, commands, configEntries, configRemoved: manifest.configRemoved ?? [], projectState, activePlanState, manifestExists: (manifest.files?.length ?? 0) > 0 };
}

export async function status(opts) {
  const data = await getStatus(opts);
  const lines = [];
  lines.push(`Diretório de config: ${data.configDir}`);
  lines.push(`Versão do pacote: ${data.packageVersion}${data.installedVersion ? ` (instalada: ${data.installedVersion})` : " — não instalado"}`);
  if (data.manifestExists) {
    lines.push(`Agentes instalados: ${data.agents}`);
    lines.push(`Comandos instalados: ${data.commands}`);
    lines.push(`Entradas geridas no config: ${data.configEntries === null ? "nenhuma" : data.configEntries}`);
    const removed = data.configRemoved?.length ?? 0;
    if (removed > 0) lines.push(`Entries stale removidos: ${removed}`);
  } else {
    lines.push("Agentes instalados: nenhum (corre 'npx loop-development init')");
  }
  const planLine = (() => {
    if (!data.projectState || data.projectState === "erro de leitura") {
      return `Projeto: sem .loop-development/ válido (corre 'npx loop-development init --project')`;
    }
    if (data.activePlanState === "erro de leitura") {
      return `Projeto: erro de leitura do estado do plano ativo (${data.projectState.activePlan})`;
    }
    if (!data.projectState.activePlan) {
      const inProgress = data.projectState.plans.filter((p) => p?.status === "in-progress");
      const done = data.projectState.plans.filter((p) => p?.status === "done").length;
      const total = data.projectState.plans.length;
      return `Projeto: sem plano ativo (${total} planos registados; ${inProgress.length} em curso; ${done} concluídos)`;
    }
    if (!data.activePlanState) {
      return `Projeto: plano ativo "${data.projectState.activePlan}" sem state.json (corre 'npx loop-development migrate' se estiveres num formato antigo)`;
    }
    const parts = [`plano ativo "${data.projectState.activePlan}"`, `fase "${data.activePlanState.phase}"`];
    if (data.activePlanState.currentTask) parts.push(`tarefa em curso: ${data.activePlanState.currentTask}`);
    parts.push(`${data.activePlanState.tasksDone} tarefas concluídas`);
    parts.push(`${data.activePlanState.tasksPending} pendentes`);
    return `Projeto: ${parts.join("; ")}`;
  })();
  lines.push(planLine);
  (opts?.log ?? ((s) => console.log(s)))(lines.join("\n"));
  return data;
}
