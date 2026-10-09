import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { resolveConfigDir } from "./config-dir.js";
import { loadManifest, fileEntry, MANIFEST_FILE } from "./manifest.js";
import { findConfigFile, parseConfig } from "./merge-config.js";
import { ensureDeps } from "./deps.js";
import { PKG_ROOT, ASSETS_DIR, readPackageJson, resolveFileAction } from "./install.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Diagnóstico da migração para OpenCode V2
// ---------------------------------------------------------------------------
//
// O plano (§4.6) define este comando como a fonte de verdade sobre se a
// instalação está de facto a funcionar em V2. Cada verificação devolve um
// resultado com `ok`, e o comando sai com código != 0 se alguma falhar.
//
// A verificação dos plugins NÃO se baseia em `opencode plugin list`: um "-" na
// coluna VERSION não é sinal de falha. A fonte de verdade é o log do OpenCode,
// onde o loader regista `failed to load plugin`.
// ---------------------------------------------------------------------------

const PLUGIN_FILES = ["plugins/session-title.ts", "plugins/telegram.ts"];

// O V1 usava mapas `permission:` e chaves `agent:`; o V2 usa o array
// `permissions:` e `agents:`. Detectamos as duas formas no config.
const V1_CONFIG_KEYS = ["agent", "permission"];

// Chaves de frontmatter do V1 que o V2 já não reconhece.
const V1_FRONTMATTER_KEYS = ["permission", "temperature", "tools"];

async function hashFile(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

// 1. Versão do OpenCode — o V1 não carrega plugins com default export.
async function checkOpencodeVersion({ log }) {
  let out = "";
  try {
    // No Windows o `opencode` é um shim .cmd/.ps1, que o Node não consegue
    // executar sem shell — o mesmo motivo de src/deps.js (§3.1).
    const { stdout } = await execFileAsync("opencode", ["--version"], {
      timeout: 15000,
      shell: process.platform === "win32",
    });
    out = String(stdout).trim();
  } catch (err) {
    return { ok: false, name: "Versão do OpenCode", detail: `não foi possível correr 'opencode --version': ${err.message}` };
  }
  const match = out.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { ok: false, name: "Versão do OpenCode", detail: `não consegui ler a versão de '${out}'` };
  }
  const [, major, minor] = match;
  const v2 = Number(major) >= 2;
  log(`${v2 ? "OK  " : "ERRO"}  OpenCode ${out}${v2 ? "" : " — é preciso v2.0 ou superior (os plugins exigem default export)"}`);
  return { ok: v2, name: "Versão do OpenCode", detail: out };
}

// 2. Manifest vs versão do pacote, ficheiros presentes e hashes stale.
async function checkManifest({ configDir, pkg, log }) {
  const manifest = await loadManifest(configDir);
  if (manifest.version == null) {
    return {
      ok: false,
      name: "Manifesto de instalação",
      detail: `sem ${MANIFEST_FILE} em ${configDir} — corre 'loop-development update'`,
    };
  }

  const problems = [];
  if (manifest.version !== pkg.version) {
    problems.push(`instalado em ${manifest.version}, pacote em ${pkg.version}`);
  }
  if (manifest.manifestVersion < 2) {
    problems.push(`manifesto v${manifest.manifestVersion} — as regras não têm identidade (rode 'update')`);
  }

  // Ficheiros embarcados ausentes em disco.
  const shipped = [];
  for (const sub of ["agents", "plugins", "commands", "scripts", "templates"]) {
    const dir = join(ASSETS_DIR, sub);
    if (!existsSync(dir)) continue;
    shipped.push(...(await walkFiles(dir, sub)));
  }
  const missing = [];
  const stale = [];
  for (const rel of shipped) {
    const dst = join(configDir, rel);
    if (!existsSync(dst)) {
      missing.push(rel);
      continue;
    }
    const shippedSha = await hashFile(join(ASSETS_DIR, rel));
    const installedSha = await hashFile(dst);
    const previousSha = fileEntry(manifest, rel)?.sha256 ?? null;
    // Mesma política do installer: só tratamos como stale o que conseguimos
    // provar que é nosso; o resto é edição do utilizador e não é erro.
    const action = resolveFileAction({ exists: true, force: false, shippedSha, installedSha, previousSha });
    if (action === "refresh") stale.push(rel);
  }

  if (missing.length > 0) problems.push(`${missing.length} ficheiro(s) em falta`);
  if (stale.length > 0) problems.push(`${stale.length} ficheiro(s) desatualizados`);

  if (problems.length > 0) {
    return {
      ok: false,
      name: "Manifesto de instalação",
      detail: problems.join("; "),
      missing,
      stale,
      modified: [],
    };
  }
  log(`OK   Manifesto em ${manifest.version}, ${shipped.length} ficheiro(s) presentes e em dia`);
  return { ok: true, name: "Manifesto de instalação", detail: manifest.version, missing, stale };
}

async function walkFiles(dir, prefix) {
  const { readdir } = await import("node:fs/promises");
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

// 3. Forma do config — chaves V1 são ignoradas pelo V2.
async function checkConfigShape({ configDir, log }) {
  const file = findConfigFile(configDir);
  if (!existsSync(file)) {
    return { ok: false, name: "Forma do config", detail: `sem config em ${configDir}` };
  }
  let config;
  try {
    config = parseConfig(await readFile(file, "utf8"));
  } catch (err) {
    return { ok: false, name: "Forma do config", detail: `${file} não é JSON válido: ${err.message}` };
  }
  const v1 = V1_CONFIG_KEYS.filter((k) => config[k] != null);
  if (v1.length > 0) {
    return {
      ok: false,
      name: "Forma do config",
      detail: `${file} ainda usa ${v1.map((k) => `"${k}"`).join(" e ")} (V1) — o V2 ignora-as. Corre com 'loop-development update'`,
      v1Keys: v1,
    };
  }
  log(`OK   Config em forma V2 (${file})`);
  return { ok: true, name: "Forma do config", detail: file };
}

// 4. Frontmatter V1 nos .md instalados — o V2 ignora-os silenciosamente.
async function checkFrontmatter({ configDir, log }) {
  const agentsDir = join(configDir, "agents");
  if (!existsSync(agentsDir)) {
    return { ok: false, name: "Frontmatter dos agentes", detail: `sem agentes em ${agentsDir}` };
  }
  const { readdir } = await import("node:fs/promises");
  const offenders = [];
  for (const file of await readdir(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const raw = await readFile(join(agentsDir, file), "utf8");
    const front = raw.split(/^---$/m)[1] ?? "";
    const bad = V1_FRONTMATTER_KEYS.filter((k) => new RegExp(`^${k}:`, "m").test(front));
    if (bad.length > 0) offenders.push(`${file} (${bad.join(", ")})`);
  }
  if (offenders.length > 0) {
    return {
      ok: false,
      name: "Frontmatter dos agentes",
      detail: `${offenders.length} agente(s) com chaves V1 — o V2 ignora-as: ${offenders.slice(0, 3).join("; ")}${offenders.length > 3 ? " …" : ""}`,
      offenders,
    };
  }
  log("OK   Frontmatter dos agentes em forma V2");
  return { ok: true, name: "Frontmatter dos agentes", detail: null };
}

// 5. Plugins: default export (estático) + log do OpenCode (truth ground).
async function checkPlugins({ configDir, log, logFile }) {
  const problems = [];

  for (const rel of PLUGIN_FILES) {
    const dst = join(configDir, rel);
    if (!existsSync(dst)) {
      problems.push(`${rel} não está instalado`);
      continue;
    }
    const raw = await readFile(dst, "utf8");
    if (!/export\s+default\s/.test(raw)) {
      problems.push(`${rel} não tem 'export default' — o loader V2 não o carrega`);
    }
  }

  const failures = await scanOpencodeLog(logFile);
  if (failures.length > 0) problems.push(...failures);

  if (problems.length > 0) {
    return { ok: false, name: "Plugins", detail: problems.join("; "), problems };
  }
  log("OK   Plugins com default export e sem falhas de carregamento no log");
  return { ok: true, name: "Plugins", detail: null };
}

// Caminho do log do OpenCode. Injectável (parâmetro `logFile` do `doctor`) para
// que os testes dependam de um log que eles escrevem, e não do estado da máquina.
export function defaultOpencodeLogFile() {
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "opencode",
    "log",
    "opencode.log",
  );
}

// O log é o truth ground: `plugin list` mostra "-" na coluna VERSION mesmo para
// plugins perfeitamente funcionais.
async function scanOpencodeLog(logFile) {
  if (!logFile || !existsSync(logFile)) return [];
  let raw = "";
  try {
    raw = await readFile(logFile, "utf8");
  } catch {
    return [];
  }
  // Só as linhas que mencionem os nossos caminhos contam, e só as mais recentes:
  // um erro antigo não deve manter o doctor em vermelho para sempre.
  const lines = raw.split(/\r?\n/).filter((l) => l.includes("failed to load plugin"));
  const ours = lines.filter((l) => PLUGIN_FILES.some((rel) => l.includes(rel.split("/").pop())));
  if (ours.length === 0) return [];
  const last = ours[ours.length - 1];
  const when = last.match(/^(\S+)/)?.[1] ?? "data desconhecida";
  return [
    `o log regista 'failed to load plugin' para os nossos plugins (última vez: ${when}) — reinicia o OpenCode depois de 'update'`,
  ];
}

// 6. Dependências — só num checkout de desenvolvimento (§4.5/§12).
async function checkDeps({ cwd, fix, dryRun, log }) {
  const result = await ensureDeps({ cwd, fix, dryRun, log });
  if (!result.isDevCheckout) {
    log("OK   Dependências: fora de um checkout de desenvolvimento — os plugins não têm dependências de runtime");
    return { ok: true, name: "Dependências", detail: null };
  }
  if (!result.ok) {
    return {
      ok: false,
      name: "Dependências",
      detail: `em falta: ${result.missing.join(", ")}${fix ? "" : " — corre com --fix para as instalar"}`,
      deps: result,
    };
  }
  log("OK   Dependências de verificação presentes");
  return { ok: true, name: "Dependências", detail: null };
}

// ---------------------------------------------------------------------------
// Comando
// ---------------------------------------------------------------------------

// `logFile` permite apontar a leitura do log do OpenCode para outro ficheiro
// (usado nos testes); por omissão é o log real da máquina, e `null` desliga a
// leitura do log.
export async function doctor({
  configDir = null,
  cwd = PKG_ROOT,
  fix = false,
  dryRun = false,
  log = console.log,
  logFile = defaultOpencodeLogFile(),
} = {}) {
  const dir = resolveConfigDir(configDir);
  const pkg = await readPackageJson();

  log(`Diagnóstico do Loop Development ${pkg.version}`);
  log(`Config: ${dir}\n`);

  const checks = [];
  checks.push(await checkOpencodeVersion({ log }));
  checks.push(await checkManifest({ configDir: dir, pkg, log }));
  checks.push(await checkConfigShape({ configDir: dir, log }));
  checks.push(await checkFrontmatter({ configDir: dir, log }));
  checks.push(await checkPlugins({ configDir: dir, log, logFile }));
  checks.push(await checkDeps({ cwd, fix, dryRun, log }));

  const failed = checks.filter((c) => !c.ok);

  log("");
  if (failed.length === 0) {
    log("Tudo em ordem.");
    return { ok: true, checks };
  }

  log(`${failed.length} verificação(ões) com problemas:`);
  for (const c of failed) log(`  - ${c.name}: ${c.detail}`);
  if (!fix) {
    log("");
    log("Corrige o que for automático com: loop-development doctor --fix");
  }
  return { ok: false, checks, failed };
}
