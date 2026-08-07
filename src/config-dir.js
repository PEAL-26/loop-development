import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_NAME = "loop-development";

export function resolveConfigDir(explicit) {
  if (explicit) return explicit;
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode");
  return join(homedir(), ".config", "opencode");
}
