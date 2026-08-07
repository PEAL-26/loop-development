#!/usr/bin/env node
import { argv } from "node:process";
import { createInterface } from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";
import { installGlobal, installProject, readPackageJson } from "../src/install.js";
import { uninstall } from "../src/uninstall.js";
import { status } from "../src/status.js";
import { setModel } from "../src/set-model.js";
import { BACKEND_PRESETS, FRONTEND_PRESETS, PACKAGE_MANAGERS, findPreset, detectPackageManager, isValidPm } from "../src/presets.js";

const USAGE = `loop-development — agente orquestrador global para o OpenCode

Uso:
  npx loop-development init [--project] [--config-dir <dir>] [--yes] [--force] [--dry-run]
      Instala os agentes e comandos do Loop Development no OpenCode (global).
      Com --project, prepara o projeto atual (.loop-development/ + AGENTS.md).
      Com --project, podes escolher presets de stack:
        npx loop-development init --project --backend nestjs-prisma --frontend expo --pm pnpm
      Sem flags de preset, abre um wizard interativo (ou usa o template em branco com --yes).

  npx loop-development update [--force] [--config-dir <dir>] [--dry-run]
      Re-sincroniza a partir do pacote (idempotente).

  npx loop-development uninstall [--config-dir <dir>] [--yes] [--dry-run]
      Remove apenas o que foi instalado pelo loop-development.

  npx loop-development status [--config-dir <dir>]
      Mostra o estado da instalação e do projeto atual.

  npx loop-development set-model <reasoning|execution|mechanical> <modelo>
      Troca o modelo de todos os agentes de uma camada (tier).

  npx loop-development --list-presets
      Lista os presets de stack disponíveis.

  npx loop-development --version | --help

Opções:
  --config-dir <dir>   Diretório de config do OpenCode (default: ~/.config/opencode)
  --yes, -y            Não pedir confirmação
  --force, -f          Sobrescrever arquivos existentes
  --dry-run            Mostrar o que seria feito sem alterar nada
  --backend <id>       Preset de backend (ex.: nestjs-prisma)
  --frontend <id>      Preset de frontend (ex.: expo)
  --pm <id>            Gestor de pacotes: npm | pnpm | yarn | bun
  --list-presets       Lista os presets disponíveis e sai
  --help, -h           Mostra esta ajuda
  --version, -v        Mostra a versão`;

function parseFlags(args) {
  const flags = { yes: false, force: false, dryRun: false, configDir: null, project: false, help: false, version: false, backend: null, frontend: null, pm: null, listPresets: false };
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
      case "--list-presets":
        flags.listPresets = true;
        break;
      case "--backend":
        flags.backend = args[++i];
        if (!flags.backend) throw new Error("--backend requer um valor");
        break;
      case "--frontend":
        flags.frontend = args[++i];
        if (!flags.frontend) throw new Error("--frontend requer um valor");
        break;
      case "--pm":
        flags.pm = args[++i];
        if (!flags.pm) throw new Error("--pm requer um valor");
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

function printPresets() {
  console.log("Presets de backend:");
  for (const p of BACKEND_PRESETS) console.log(`  ${p.id} — ${p.label}`);
  console.log("Presets de frontend:");
  for (const p of FRONTEND_PRESETS) console.log(`  ${p.id} — ${p.label}`);
}

async function chooseFromList({ rl, question, items }) {
  console.log(`\n${question}`);
  items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2, " ")}. ${it.label}`));
  for (;;) {
    const answer = (await rl.question("> ")).trim();
    if (answer === "") return items[0];
    const idx = Number(answer);
    if (Number.isInteger(idx) && idx >= 1 && idx <= items.length) return items[idx - 1];
    const byId = items.find((it) => it.id === answer);
    if (byId) return byId;
    console.log("  Escolha inválida. Insere o número ou o id.");
  }
}

async function runProjectWizard({ targetDir, flags }) {
  let backend = flags.backend;
  let frontend = flags.frontend;
  let pm = flags.pm;

  const manualLabel = (kind) => `manual (deixar ${kind} em branco)`;
  const interactive = process.stdin.isTTY === true && !flags.yes && !flags.dryRun;

  if (interactive && (backend === null || frontend === null)) {
    const rl = createPrompt({ input: process.stdin, output: process.stdout });
    try {
      if (backend === null) {
        backend = (await chooseFromList({ rl, question: "Escolhe o padrão de BACKEND:", items: [...BACKEND_PRESETS, { id: null, label: manualLabel("o backend") }] })).id;
      }
      if (frontend === null) {
        frontend = (await chooseFromList({ rl, question: "Escolhe o padrão de FRONTEND:", items: [...FRONTEND_PRESETS, { id: null, label: manualLabel("o frontend") }] })).id;
      }
      if (pm === null && (backend || frontend)) {
        const detected = await detectPackageManager(targetDir);
        if (detected) {
          pm = detected;
          console.log(`\nGestor de pacotes detetado no projeto: ${detected}`);
        } else {
          pm = (await chooseFromList({ rl, question: "Gestor de pacotes:", items: PACKAGE_MANAGERS })).id;
        }
      }
    } finally {
      rl.close();
    }
  } else if (pm === null && (backend || frontend)) {
    pm = (await detectPackageManager(targetDir)) ?? null;
  }

  return { backend, frontend, pm };
}

async function runInit(flags, rest) {
  if (flags.project) {
    const targetDir = rest[1] ?? process.cwd();
    if (flags.backend && !findPreset("backend", flags.backend)) {
      console.error(`erro: preset de backend desconhecido "${flags.backend}". Disponíveis: ${BACKEND_PRESETS.map((p) => p.id).join(", ")}`);
      return 1;
    }
    if (flags.frontend && !findPreset("frontend", flags.frontend)) {
      console.error(`erro: preset de frontend desconhecido "${flags.frontend}". Disponíveis: ${FRONTEND_PRESETS.map((p) => p.id).join(", ")}`);
      return 1;
    }
    if (flags.pm && !isValidPm(flags.pm)) {
      console.error(`erro: gestor de pacotes desconhecido "${flags.pm}". Disponíveis: ${PACKAGE_MANAGERS.map((p) => p.id).join(", ")}`);
      return 1;
    }

    const wizardRan = process.stdin.isTTY === true && !flags.yes && !flags.dryRun && (flags.backend === null || flags.frontend === null);
    const { backend, frontend, pm } = await runProjectWizard({ targetDir, flags });

    if (!wizardRan && !flags.yes && !flags.dryRun) {
      const ok = await askConfirmation(`Preparar o projeto ${targetDir} (.loop-development/ + AGENTS.md)?`, { flags, dryRun: flags.dryRun });
      if (!ok) {
        console.log("Cancelado.");
        return 1;
      }
    }
    await installProject({ targetDir, force: flags.force, dryRun: flags.dryRun, log: console.log, backend, frontend, pm });
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
  if (flags.listPresets) {
    printPresets();
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
