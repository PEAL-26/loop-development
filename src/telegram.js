import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { resolveConfigDir } from "./config-dir.js";

export const TELEGRAM_STATE_FILE = "telegram-state.json";

export function defaultTelegramState() {
  return { token: null, pairingKey: null, allowedChatIds: [] };
}

export async function readTelegramState(configDir) {
  try {
    const raw = await readFile(join(configDir, TELEGRAM_STATE_FILE), "utf8");
    return { ...defaultTelegramState(), ...JSON.parse(raw) };
  } catch {
    return defaultTelegramState();
  }
}

export async function writeTelegramState(configDir, state) {
  await writeFile(
    join(configDir, TELEGRAM_STATE_FILE),
    JSON.stringify(state, null, 2) + "\n",
    "utf8",
  );
}

export function generatePairingKey() {
  return randomBytes(4).toString("hex");
}

export async function telegramGetMe(token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    return await res.json();
  } catch {
    return { ok: false, description: "não foi possível contactar a API do Telegram" };
  }
}

export function maskToken(token) {
  if (!token) return null;
  return `${token.slice(0, 10)}…${token.slice(-4)}`;
}

async function promptToken() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("Token do bot (do @BotFather): ")).trim();
  } finally {
    rl.close();
  }
}

export async function telegramSetup({
  configDir,
  token = null,
  pairingKey = null,
  reset = false,
  dryRun = false,
  log = () => {},
} = {}) {
  const dir = resolveConfigDir(configDir);
  let state = reset ? defaultTelegramState() : await readTelegramState(dir);

  if (reset) log("Reiniciar configuração do Telegram.");

  const effectiveToken = token || process.env.OPENCODE_TELEGRAM_BOT_TOKEN || state.token;
  if (!effectiveToken) {
    const interactive = process.stdin.isTTY === true && !dryRun;
    if (!interactive) {
      throw new Error(
        "Falta o token do bot. Usa --token <token> ou a env OPENCODE_TELEGRAM_BOT_TOKEN.",
      );
    }
    state.token = await promptToken();
  } else {
    state.token = effectiveToken;
  }

  if (pairingKey) state.pairingKey = pairingKey;
  if (!state.pairingKey) state.pairingKey = generatePairingKey();

  const me = await telegramGetMe(state.token);
  if (!me.ok) {
    throw new Error(`Token inválido: ${me.description ?? "não respondeu"}`);
  }

  if (!dryRun) await writeTelegramState(dir, state);

  log(`Bot verificado: @${me.result?.username ?? "?"} (${me.result?.first_name ?? ""})`.trimEnd());
  log(`Estado: ${join(dir, TELEGRAM_STATE_FILE)}`);
  log(`Token: ${maskToken(state.token)} (ou exporta OPENCODE_TELEGRAM_BOT_TOKEN)`);
  log(`Chave de emparelhamento: ${state.pairingKey}`);
  log(
    `Chats autorizados: ${state.allowedChatIds.length === 0 ? "nenhum ainda" : state.allowedChatIds.join(", ")}`,
  );
  log(`\nNo telemóvel, abre o bot @${me.result?.username ?? ""} e envia:`);
  log(`  /start ${state.pairingKey}`);
  if (dryRun) log("(--dry-run: nada foi alterado)");
  return { username: me.result?.username, pairingKey: state.pairingKey };
}

export async function telegramStatus({ configDir, log = () => {} } = {}) {
  const dir = resolveConfigDir(configDir);
  const file = join(dir, TELEGRAM_STATE_FILE);
  if (!existsSync(file)) {
    log("Telegram não configurado. Corre: loop-development telegram setup");
    return { configured: false };
  }
  const state = await readTelegramState(dir);
  log(`Telegram configurado em ${file}`);
  log(`Token: ${maskToken(state.token)}`);
  log(`Chave de emparelhamento: ${state.pairingKey ?? "(não definida)"}`);
  log(
    `Chats autorizados: ${state.allowedChatIds.length === 0 ? "nenhum" : state.allowedChatIds.join(", ")}`,
  );
  return { configured: true };
}

export async function telegramReset({ configDir, dryRun = false, log = () => {} } = {}) {
  const dir = resolveConfigDir(configDir);
  const file = join(dir, TELEGRAM_STATE_FILE);
  if (!dryRun) await rm(file, { force: true });
  log(dryRun ? `(--dry-run) Removeria ${file}` : `Removido ${file}`);
}
