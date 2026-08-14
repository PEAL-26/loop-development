#!/usr/bin/env node
import { argv } from "node:process";
import { createInterface } from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";
import { installGlobal, installProject, readPackageJson } from "../src/install.js";
import { uninstall } from "../src/uninstall.js";
import { status } from "../src/status.js";
import { DEFAULT_MODELS, TIERS, setModel, setModels } from "../src/set-model.js";
import { auditInstalledModels } from "../src/models.js";
import { migrateProject } from "../src/plan.js";
import { checkArchitecture } from "../src/architecture.js";
import { BACKEND_PRESETS, FRONTEND_PRESETS, PACKAGE_MANAGERS, findPreset, detectPackageManager, isValidPm } from "../src/presets.js";
import { telegramSetup, telegramStatus, telegramReset } from "../src/telegram.js";
import { addAllowedFolder, removeAllowedFolder, listAllowedFolders, clearAllowedFolders } from "../src/access.js";
import { link, unlink } from "../src/link.js";

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

  npx loop-development set-model <reasoning|coding|docs|mechanical> <modelo>
      Troca o modelo de todos os agentes de uma camada (compatibilidade).
  npx loop-development set-model --reasoning <modelo> [--coding <modelo>] [--docs <modelo>] [--mechanical <modelo>]
      Troca os modelos dos tiers indicados; tiers omitidos permanecem iguais.
  npx loop-development set-model --all <modelo>
      Troca o modelo de todos os agentes de todos os tiers.
  npx loop-development set-model --defaults
      Restaura os modelos default de todos os tiers.

  npx loop-development models [--config-dir <dir>]
      Audita os modelos configurados nos agentes instalados contra o catálogo
      models.dev e reporta modelos deprecated ou inexistentes.

  npx loop-development migrate [<dir>]
      Converte um projeto no formato antigo (.loop-development/ flat) para a
      estrutura nova por planos (plans/<timestamp>-projeto-inicial/).

  npx loop-development architecture check [<dir>]
      Audita .loop-development/architecture.md contra o contrato de arquitetura
      (base estrutural geral, sem detalhes de features/implementação). Apenas
      sinaliza, não altera nada. Exit code 0 se limpo, 1 com violações.
      (A poda real é feita pelo Planner Writer ao documentar cada plano.)

  npx loop-development allow add <caminho> | remove <caminho> | list | clear
      Gere a lista de pastas externas permitidas (fora do diretório do projeto).
      Escreve permission.external_directory no opencode.json do projeto.
      add valida que a pasta existe; remove/clear só tocam entradas da lista.

  npx loop-development link
      Deteta e liga automaticamente o projeto ao main (acima) e aos children
      (abaixo), persistindo parent/children no state.json e concedendo acesso
      externo à raiz do main. Idempotente; reconcilia referências stale.
  npx loop-development unlink <caminho>
      Desliga a ligação com o main ou o child indicado (estado + grants).

  npx loop-development --list-presets
      Lista os presets de stack disponíveis.

  npx loop-development telegram setup [--token <token>] [--pairing-key <chave>] [--reset]
      Configura o bot do Telegram para aprovações remotas (permissões e perguntas).
  npx loop-development telegram status
      Mostra o estado da configuração do Telegram.
  npx loop-development telegram reset [--yes]
      Remove a configuração do Telegram.

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
  const flags = { yes: false, force: false, dryRun: false, configDir: null, project: false, help: false, version: false, backend: null, frontend: null, pm: null, listPresets: false, token: null, pairingKey: null, reset: false, noLink: false, modelAll: null, modelDefaults: false, modelTiers: {} };
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
      case "--token":
        flags.token = args[++i];
        if (!flags.token) throw new Error("--token requer um valor");
        break;
      case "--pairing-key":
        flags.pairingKey = args[++i];
        if (!flags.pairingKey) throw new Error("--pairing-key requer um valor");
        break;
      case "--reset":
        flags.reset = true;
        break;
      case "--no-link":
        flags.noLink = true;
        break;
      case "--all":
        flags.modelAll = args[++i];
        if (!flags.modelAll) throw new Error("--all requer um modelo");
        break;
      case "--defaults":
        flags.modelDefaults = true;
        break;
      case "--reasoning":
      case "--coding":
      case "--docs":
      case "--mechanical": {
        const tier = a.slice(2);
        flags.modelTiers[tier] = args[++i];
        if (!flags.modelTiers[tier]) throw new Error(`${a} requer um modelo`);
        break;
      }
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
    await installProject({ targetDir, force: flags.force, dryRun: flags.dryRun, log: console.log, backend, frontend, pm, noLink: flags.noLink });
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
  try {
    const positional = rest.slice(1);
    const flagModes = [flags.modelAll !== null, flags.modelDefaults, Object.keys(flags.modelTiers).length > 0].filter(Boolean).length;
    if (positional.length > 0 && flagModes > 0) {
      throw new Error("não combines a sintaxe posicional com --all, --defaults ou flags de tier");
    }

    if (positional.length > 0) {
      if (positional.length !== 2) throw new Error(`Uso: loop-development set-model <${TIERS.join("|")}> <provider/model-id>`);
      await setModel(positional[0], positional[1], { configDir: flags.configDir, dryRun: flags.dryRun, log: console.log });
      return 0;
    }

    if (flagModes !== 1) {
      throw new Error("especifica exatamente uma modalidade: --all <modelo>, --defaults ou flags de tier");
    }

    const models = flags.modelAll !== null
      ? Object.fromEntries(TIERS.map((tier) => [tier, flags.modelAll]))
      : flags.modelDefaults
        ? DEFAULT_MODELS
        : flags.modelTiers;
    await setModels(models, { configDir: flags.configDir, dryRun: flags.dryRun, log: console.log });
    return 0;
  } catch (err) {
    console.error(`erro: ${err.message}`);
    return 1;
  }
}

async function runModels(flags) {
  try {
    const models = await auditInstalledModels({ configDir: flags.configDir, log: console.log });
    if (models.length === 0) {
      console.log("Nenhum agente com modelo encontrado.");
      return 0;
    }
    console.log("\nModelos nos agentes instalados (vs models.dev):");
    let problems = 0;
    for (const { agent, model, status } of models) {
      const badge = status === "ok" ? "ok" : status === "deprecated" ? "DEPRECATED" : status === "not-found" ? "NÃO ENCONTRADO" : "?";
      if (status === "deprecated" || status === "not-found") problems += 1;
      console.log(`  ${badge.padEnd(13)} ${agent.padEnd(24)} ${model}`);
    }
    if (problems > 0) {
      console.log(`\n${problems} modelo(s) com problema. Corre 'loop-development set-model <tier> <novo-modelo>' para corrigir.`);
    } else {
      console.log("\nTodos os modelos parecem válidos no catálogo.");
    }
    return problems > 0 ? 1 : 0;
  } catch (err) {
    console.error(`erro: ${err.message}`);
    return 1;
  }
}

async function runMigrate(rest, flags) {
  const targetDir = rest[1] ?? process.cwd();
  const ok = await askConfirmation(`Converter o estado persistente de ${targetDir} para a estrutura por planos?`, { flags, dryRun: flags.dryRun });
  if (!ok) {
    console.log("Cancelado.");
    return 1;
  }
  await migrateProject({ targetDir, dryRun: flags.dryRun, log: console.log });
  return 0;
}

async function runArchitecture(rest, flags) {
  const sub = rest[1];
  if (sub !== "check") {
    console.error(`loop-development: uso: architecture check [<dir>]\n\n${USAGE}`);
    return 1;
  }
  const targetDir = rest[2] ?? process.cwd();
  const result = await checkArchitecture({ targetDir, log: console.log });
  if (result.missing) return 0;
  return result.violations.length > 0 ? 1 : 0;
}

async function runTelegram(rest, flags) {
  const sub = rest[1];
  try {
    if (sub === "setup") {
      await telegramSetup({ configDir: flags.configDir, token: flags.token, pairingKey: flags.pairingKey, reset: flags.reset, dryRun: flags.dryRun, log: console.log });
      return 0;
    }
    if (sub === "status") {
      await telegramStatus({ configDir: flags.configDir, log: console.log });
      return 0;
    }
    if (sub === "reset") {
      const ok = await askConfirmation("Remover a configuracao do Telegram?", { flags, dryRun: flags.dryRun });
      if (!ok) {
        console.log("Cancelado.");
        return 1;
      }
      await telegramReset({ configDir: flags.configDir, dryRun: flags.dryRun, log: console.log });
      return 0;
    }
    console.error(`loop-development: uso: telegram <setup|status|reset>\n\n${USAGE}`);
    return 1;
  } catch (err) {
    console.error(`erro: ${err.message}`);
    return 1;
  }
}

async function runAllow(rest, flags) {
  const sub = rest[1];
  const projectDir = process.cwd();
  try {
    switch (sub) {
      case "add": {
        const p = rest[2];
        if (!p) throw new Error("uso: loop-development allow add <caminho>");
        const r = await addAllowedFolder({ projectDir, path: p, dryRun: flags.dryRun, log: console.log });
        if (!r.changed) console.log("Nada a alterar.");
        return 0;
      }
      case "remove": {
        const p = rest[2];
        if (!p) throw new Error("uso: loop-development allow remove <caminho>");
        const r = await removeAllowedFolder({ projectDir, path: p, dryRun: flags.dryRun, log: console.log });
        if (!r.changed) console.log("Nada a alterar.");
        return 0;
      }
      case "list":
        await listAllowedFolders(projectDir, console.log);
        return 0;
      case "clear": {
        const ok = await askConfirmation("Remover todas as pastas externas permitidas?", { flags, dryRun: flags.dryRun });
        if (!ok) {
          console.log("Cancelado.");
          return 1;
        }
        await clearAllowedFolders({ projectDir, dryRun: flags.dryRun, log: console.log });
        return 0;
      }
      default:
        console.error(`loop-development: uso: allow <add|remove|list|clear>\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    console.error(`erro: ${err.message}`);
    return 1;
  }
}

async function runLink(rest, flags) {
  try {
    const projectDir = rest[1] ?? process.cwd();
    const result = await link({ projectDir, dryRun: flags.dryRun, log: console.log });
    if (!result.parent && !result.parentCleared && result.childrenAdded.length === 0 && result.childrenRemoved.length === 0 && !result.parentChildrenAdded) {
      console.log("Sem ligações detetadas (nem main acima nem children abaixo).");
    }
    return 0;
  } catch (err) {
    console.error(`erro: ${err.message}`);
    return 1;
  }
}

async function runUnlink(rest, flags) {
  const p = rest[1];
  if (!p) {
    console.error(`loop-development: uso: unlink <caminho>\n\n${USAGE}`);
    return 1;
  }
  try {
    await unlink({ projectDir: process.cwd(), path: p, dryRun: flags.dryRun, log: console.log });
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
      case "models":
        return await runModels(flags);
      case "migrate":
        return await runMigrate(rest, flags);
      case "architecture":
        return await runArchitecture(rest, flags);
      case "telegram":
        return await runTelegram(rest, flags);
      case "allow":
        return await runAllow(rest, flags);
      case "link":
        return await runLink(rest, flags);
      case "unlink":
        return await runUnlink(rest, flags);
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
