#!/usr/bin/env node
import { argv } from "node:process";
import { createInterface } from "node:readline";
import { installGlobal, installProject, readPackageJson } from "../src/install.js";
import { uninstall } from "../src/uninstall.js";
import { status } from "../src/status.js";
import { setModel } from "../src/set-model.js";

const USAGE = `loop-development — agente orquestrador global para o OpenCode

Uso:
  npx loop-development init [--project] [--config-dir <dir>] [--yes] [--force] [--dry-run]
      Instala os agentes e comandos do Loop Development no OpenCode (global).
      Com --project, prepara o projeto atual (.loop-development/ + AGENTS.md).

  npx loop-development update [--force] [--config-dir <dir>] [--dry-run]
      Re-sincroniza a partir do pacote (idempotente).

  npx loop-development uninstall [--config-dir <dir>] [--yes] [--dry-run]
      Remove apenas o que foi instalado pelo loop-development.

  npx loop-development status [--config-dir <dir>]
      Mostra o estado da instalação e do projeto atual.

  npx loop-development set-model <reasoning|execution|mechanical> <modelo>
      Troca o modelo de todos os agentes de uma camada (tier).

  npx loop-development --version | --help

Opções:
  --config-dir <dir>   Diretório de config do OpenCode (default: ~/.config/opencode)
  --yes, -y            Não pedir confirmação
  --force, -f          Sobrescrever arquivos existentes
  --dry-run            Mostrar o que seria feito sem alterar nada
  --help, -h           Mostra esta ajuda
  --version, -v        Mostra a versão`;

function parseFlags(args) {
  const flags = { yes: false, force: false, dryRun: false, configDir: null, project: false, help: false, version: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--yes":
      case "-y":
        flags.yes = true;
        break;
      case "--force":
      case "-f":
        flags.force = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--project":
        flags.project = true;
        break;
      case "--config-dir":
        flags.configDir = args[++i];
        if (!flags.configDir) throw new Error("--config-dir requer um valor");
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--version":
      case "-v":
        flags.version = true;
        break;
      default:
        rest.push(a);
    }
  }
  return { flags, rest };
}

function confirm(message) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} (s/N) `, (answer) => {
      rl.close();
      resolve(/^s/i.test(answer.trim()));
    });
  });
}

async function askConfirmation(message, { flags, dryRun }) {
  if (dryRun || flags.yes) return true;
  return confirm(message);
}

async function runInit(flags, rest) {
  if (flags.project) {
    const targetDir = rest[1] ?? process.cwd();
    const ok = await askConfirmation(`Preparar o projeto ${targetDir} (.loop-development/ + AGENTS.md)?`, { flags, dryRun: flags.dryRun });
    if (!ok) {
      console.log("Cancelado.");
      return 1;
    }
    await installProject({ targetDir, force: flags.force, dryRun: flags.dryRun, log: console.log });
    return 0;
  }

  const ok = await askConfirmation(
    `Instalar agentes/comandos do Loop Development em ${flags.configDir ?? "~/.config/opencode"} e mesclar o opencode.json?`,
    { flags, dryRun: flags.dryRun }
  );
  if (!ok) {
    console.log("Cancelado.");
    return 1;
  }
  await installGlobal({ configDir: flags.configDir, force: flags.force, dryRun: flags.dryRun, log: console.log });
  return 0;
}

async function runUpdate(flags) {
  await installGlobal({ configDir: flags.configDir, force: flags.force, dryRun: flags.dryRun, log: console.log });
  return 0;
}

async function runUninstall(flags) {
  const ok = await askConfirmation("Remover o Loop Development instalado? A tua configuração não relacionada não será tocada.", { flags, dryRun: flags.dryRun });
  if (!ok) {
    console.log("Cancelado.");
    return 1;
  }
  await uninstall({ configDir: flags.configDir, dryRun: flags.dryRun, log: console.log });
  return 0;
}

async function runSetModel(rest, flags) {
  const [tier, model] = rest.slice(1);
  try {
    await setModel(tier, model, { configDir: flags.configDir, dryRun: flags.dryRun, log: console.log });
    return 0;
  } catch (err) {
    console.error(`erro: ${err.message}`);
    return 1;
  }
}

async function main() {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.log(USAGE);
    return 0;
  }

  let flags;
  let rest;
  try {
    ({ flags, rest } = parseFlags(args));
  } catch (err) {
    console.error(`loop-development: ${err.message}\n\n${USAGE}`);
    return 1;
  }

  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (flags.version) {
    const pkg = await readPackageJson();
    console.log(pkg.version);
    return 0;
  }

  const command = rest[0];
  try {
    switch (command) {
      case "init":
        return await runInit(flags, rest);
      case "update":
        return await runUpdate(flags);
      case "uninstall":
        return await runUninstall(flags);
      case "status":
        await status({ configDir: flags.configDir });
        return 0;
      case "set-model":
        return await runSetModel(rest, flags);
      default:
        console.error(`loop-development: comando desconhecido "${command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    console.error(`loop-development: ${err.message}`);
    return 1;
  }
}

main().then((code) => process.exitCode = code);
