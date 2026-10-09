import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import type { Plugin } from "@opencode/plugin";
import * as core from "./core/session-title-core.js";
import { eventSessionID, isLocalEvent } from "./core/events.js";

// Plugin: renomeia sessões do Loop Development com o nome do plano ativo.
// - Só atua em sessões cujo agente esteja em `agents` (default: loop-development).
// - Lê o plano ativo de .loop-development/state.json do projeto.
// - O estado (último título definido por sessão) vive em ctx.storage, que é
//   durável e scoped por plugin id — logo já não é preciso escrever
//   .loop-development/session-titles.json (nem adicioná-lo ao .gitignore).
// - Config global em session-title.jsonc na pasta de config do opencode:
//     { "enabled": true, "agents": ["loop-development"],
//       "prefix": "", "suffix": "", "mode": "first", "debug": false }
//
// O import acima é só de tipos: é apagado em runtime, portanto o plugin não
// precisa de @opencode/plugin instalado nem de node_modules na pasta de config.
// O loader do V2 aceita um default export com { id, setup } — Plugin.define é
// apenas um helper de tipos em cima desse shape.

const STORAGE_KEY = "titles";

function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode");
  return join(homedir(), ".config", "opencode");
}

const CONFIG_FILE = join(configDir(), "session-title.jsonc");

async function readActivePlan(projectDir: string) {
  try {
    const raw = await readFile(join(projectDir, ".loop-development", "state.json"), "utf8");
    return core.activePlanId(JSON.parse(raw));
  } catch {
    return null;
  }
}

const plugin: Plugin.Plugin = {
  id: "loop-development.session-title",

  async setup(ctx) {
    let config = core.defaultConfig();
    try {
      config = core.mergeConfig(core.parseJson(await readFile(CONFIG_FILE, "utf8")));
    } catch {
      config = core.defaultConfig();
    }
    if (config.debug) console.error(`[session-title] config: ${JSON.stringify(config)}`);

    // No V2 o plugin é instanciado por localização, por isso o directório do
    // projeto vem do contexto — não da sessão (o V1 tinha uma única instância
    // para todas as sessões e lia info.directory).
    const directory = ctx.location.directory;

    // Tudo abaixo é estado por instância. Estado module-level seria partilhado
    // entre localizações, que é um bug silencioso.
    const agentsBySession = new Map<string, string>();

    // O V1 capturava o agente em `chat.message`. Esse hook não existe em V2; o
    // equivalente é o hook de contexto, que expõe o agente activo e corre no
    // início de cada ciclo do agente.
    await ctx.session.hook("context", (event) => {
      if (event.sessionID && event.agent) agentsBySession.set(event.sessionID, event.agent);
    });

    const readState = async () => {
      try {
        return core.normalizeState(await ctx.storage.get(STORAGE_KEY));
      } catch {
        return core.emptyState();
      }
    };

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            // O stream de eventos é global; só reagimos à nossa localização.
            if (!isLocalEvent(event, directory)) continue;
            if (event.type !== "session.idle") continue;
            const sessionID = eventSessionID(event);
            if (!sessionID) continue;

            const agent = agentsBySession.get(sessionID);
            const info = await ctx.session.get({ sessionID });
            const activePlan = await readActivePlan(directory);
            const state = await readState();

            const decision = core.decideAction({
              config,
              agent,
              activePlan,
              currentTitle: info?.title ?? "",
              lastSetTitle: core.lastTitleFor(state, sessionID),
            });

            if (config.debug) {
              console.error(
                `[session-title] ${sessionID} agent=${agent} plan=${activePlan} title="${info?.title}" -> ${decision.action} (${decision.reason})`,
              );
            }

            if (decision.action === "set") {
              await ctx.session.update({ sessionID, title: decision.title });
              await ctx.storage.set(STORAGE_KEY, core.updateLastTitle(state, sessionID, decision.title, activePlan));
            }
          } catch (err) {
            if (config.debug) console.error("[session-title] evento:", err);
          }
        }
      } catch (err) {
        if (config.debug) console.error("[session-title] stream:", err);
      }
    })();

    return () => controller.abort();
  },
};

export default plugin;