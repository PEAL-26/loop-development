import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { Plugin } from "@opencode-ai/plugin";
import * as core from "./core/session-title-core.js";

// Plugin: renomeia sessões do Loop Development com o nome do plano ativo.
// - Só atua em sessões cujo agente esteja em `agents` (default: loop-development).
// - Lê o plano ativo de .loop-development/state.json do projeto da sessão.
// - Escreve o estado (último título definido por sessão) em
//   .loop-development/session-titles.json para respeitar renomes manuais.
// - Config global em session-title.jsonc na pasta de config do opencode:
//     { "enabled": true, "agents": ["loop-development"],
//       "prefix": "", "suffix": "", "mode": "first", "debug": false }

function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode");
  return join(homedir(), ".config", "opencode");
}

const CONFIG_FILE = join(configDir(), "session-title.jsonc");

let client: any = null;
let directory = "";
let config = core.defaultConfig();
let state = core.emptyState();
let agentsBySession = new Map<string, string>();

async function loadConfig() {
  try {
    config = core.mergeConfig(core.parseJson(await readFile(CONFIG_FILE, "utf8")));
  } catch {
    config = core.defaultConfig();
  }
}

function stateFile(projectDir: string) {
  return join(projectDir, ".loop-development", "session-titles.json");
}

async function loadState(projectDir: string) {
  try {
    state = core.parseState(await readFile(stateFile(projectDir), "utf8"));
  } catch {
    state = core.emptyState();
  }
}

async function saveState(projectDir: string) {
  try {
    const file = stateFile(projectDir);
    await mkdir(join(projectDir, ".loop-development"), { recursive: true });
    await writeFile(file, core.serializeState(state), "utf8");
  } catch (err) {
    if (config?.debug) console.error("[session-title] save state:", err);
  }
}

async function readActivePlan(projectDir: string) {
  try {
    const raw = await readFile(join(projectDir, ".loop-development", "state.json"), "utf8");
    return core.activePlanId(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function renameSession(sessionID: string, projectDir: string, title: string, plan: string) {
  try {
    await client.session.update({ id: sessionID, body: { title } });
    state = core.updateLastTitle(state, sessionID, title, plan);
    await saveState(projectDir);
  } catch (err) {
    console.error("[session-title] update:", err);
  }
}

export const sessionTitle: Plugin = async (ctx) => {
  client = ctx.client;
  directory = ctx.directory;
  await loadConfig();

  if (config?.debug) {
    console.error(`[session-title] config: ${JSON.stringify(config)}`);
  }

  return {
    "chat.message": async ({ sessionID, agent }: any) => {
      if (sessionID) agentsBySession.set(sessionID, agent);
    },
    event: async ({ event }: any) => {
      try {
        if (event?.type !== "session.idle") return;
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        const agent = agentsBySession.get(sessionID);
        const info: any = await client.session.get({ id: sessionID });
        const projectDir = info?.directory || directory;
        const activePlan = await readActivePlan(projectDir);
        await loadState(projectDir);

        const decision = core.decideAction({
          config,
          agent,
          activePlan,
          currentTitle: info?.title ?? "",
          lastSetTitle: core.lastTitleFor(state, sessionID),
        });

        if (config?.debug) {
          console.error(
            `[session-title] ${sessionID} agent=${agent} plan=${activePlan} title="${info?.title}" -> ${decision.action} (${decision.reason})`,
          );
        }

        if (decision.action === "set") {
          await renameSession(sessionID, projectDir, decision.title, activePlan);
        }
      } catch (err) {
        if (config?.debug) console.error("[session-title] event:", err);
      }
    },
  };
};
