import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_PATTERNS = [
  { id: "private-key", label: "chave privada (PEM/OpenSSH)", confidence: "high", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { id: "openai-key", label: "token OpenAI (sk-)", confidence: "high", regex: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: "github-pat", label: "GitHub PAT (ghp_/gho_/ghu_/ghs_)", confidence: "high", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "github-app-token", label: "token de app GitHub", confidence: "high", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: "gitlab-pat", label: "token de acesso GitLab", confidence: "high", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: "aws-access-key", label: "AWS Access Key (AKIA)", confidence: "high", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "google-api-key", label: "chave Google API (AIza)", confidence: "high", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "slack-token", label: "token Slack (xox)", confidence: "high", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "stripe-secret", label: "chave secreta Stripe", confidence: "high", regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { id: "env-pair-secret", label: "par NOME_VAR=valor tipo chave", confidence: "high", regex: /(?:^|[\s;])(?:([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|ACCESS|CLIENT)[A-Z0-9_]*)(?:\s*=\s*"[^"\n]{16,}"|\s*=\s*'[^'\n]{16,}'|\s*=\s*[A-Za-z0-9_./+\-]{24,})|([A-Z][A-Z0-9_]{2,})\s*=\s*[A-Za-z0-9_./+\-]{24,})/ },
  { id: "jwt", label: "JWT (possível)", confidence: "low", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "url-credentials", label: "URL com credenciais", confidence: "low", regex: /https?:\/\/[^/\s@]+:[^/\s@]+@[^/\s]+/i },
  { id: "env-mention", label: "menção a .env em docs sem valor", confidence: "low", regex: /(?<!process\.)(?<![A-Za-z0-9_])\.env(?!\.example)(?![A-Za-z0-9_.-])/ },
  { id: "short-secret-pair", label: "par NOME_VAR=valor curto ambíguo", confidence: "low", regex: /(?:^|[\s;])([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|ACCESS|CLIENT)[A-Z0-9_]*)\s*=\s*("[^"\n]{1,15}"|'[^'\n]{1,15}'|[A-Za-z0-9._/+:=-]{1,23})/ }
];

export const ENV_FILE_RE = /(^|[/\\])\.env(\.local|\.\w+)?$/;

const REDACTED = "<redigido>";

export function parseJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

function countLines(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") n++;
  }
  return n;
}

function redact(text, matchIndex, matchLength) {
  const before = text.slice(Math.max(0, matchIndex - 24), matchIndex).replace(/\n/g, " ").trim();
  const after = text.slice(matchIndex + matchLength, matchIndex + matchLength + 24).replace(/\n/g, " ").trim();
  return `${before} ${REDACTED} ${after}`.trim().slice(0, 160);
}

export function scanText(text, patterns = DEFAULT_PATTERNS) {
  const findings = [];
  for (const p of patterns) {
    if (!(p.regex instanceof RegExp)) continue;
    const re = new RegExp(p.regex.source, p.regex.flags.includes("g") ? p.regex.flags : `${p.regex.flags}g`);
    let m;
    while ((m = re.exec(text)) !== null) {
      findings.push({
        patternId: p.id,
        label: p.label,
        confidence: p.confidence,
        line: countLines(text, m.index),
        snippet: redact(text, m.index, m[0].length)
      });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  return findings;
}

function globToRegExp(glob) {
  let out = "";
  const g = glob.replace(/\*\*/g, "\u0001");
  for (const ch of g) {
    if (ch === "\u0001") out += ".*";
    else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function makeIgnorer(patterns = []) {
  const res = patterns.map(globToRegExp);
  return (rel) => res.some((re) => re.test(rel));
}

export async function loadConfig({ targetDir }) {
  const base = { version: 1, patterns: DEFAULT_PATTERNS, ignore: [] };
  const file = join(targetDir, ".loop-development", "secret-patterns.jsonc");
  try {
    const raw = await readFile(file, "utf8");
    const json = parseJsonc(raw);
    const extra = Array.isArray(json?.patterns) ? json.patterns : [];
    const ignore = Array.isArray(json?.ignore) ? json.ignore : [];
    return {
      ...base,
      patterns: [...base.patterns, ...extra],
      ignore
    };
  } catch {
    return base;
  }
}

export async function isGitRepo(targetDir) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: targetDir });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function listTrackedFiles(targetDir) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: targetDir, maxBuffer: 256 * 1024 * 1024 });
  return stdout.split("\0").filter(Boolean);
}

export async function scanWorkingTree({ targetDir, patterns = DEFAULT_PATTERNS, ignore = [] } = {}) {
  const files = await listTrackedFiles(targetDir);
  const findings = [];
  const envFindings = [];
  const ignorer = makeIgnorer(ignore);
  for (const rel of files) {
    if (ENV_FILE_RE.test(rel)) {
      if (!rel.endsWith(".env.example")) {
        envFindings.push({
          file: rel,
          patternId: "env-tracked",
          label: "ficheiro .env versionado",
          confidence: "high",
          line: 1,
          snippet: "remover do controlo de versão (git rm --cached) e garantir no .gitignore"
        });
      }
      continue;
    }
    if (rel.includes("node_modules") || ignorer(rel)) continue;
    let content;
    try {
      content = await readFile(join(targetDir, rel), "utf8");
    } catch {
      continue;
    }
    for (const f of scanText(content, patterns)) {
      findings.push({ ...f, file: rel });
    }
  }
  return { findings, envFindings };
}

function runCatFileBatch(cwd, input) {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["cat-file", "--batch"], { cwd });
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.stderr.on("data", () => {});
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`git cat-file --batch falhou (exit ${code})`));
      resolve(Buffer.concat(chunks));
    });
    proc.stdin.end(input);
  });
}

export async function scanHistory({ targetDir, patterns = DEFAULT_PATTERNS } = {}) {
  const { stdout } = await execFileAsync("git", ["rev-list", "--objects", "--all"], { cwd: targetDir, maxBuffer: 512 * 1024 * 1024 });
  const blobs = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const sp = line.indexOf(" ");
    if (sp === -1) continue;
    const sha = line.slice(0, sp).trim();
    const path = line.slice(sp + 1).trim();
    if (sha && path) blobs.set(sha, path);
  }
  const shas = [...blobs.keys()];
  if (shas.length === 0) return { findings: [] };

  const buf = await runCatFileBatch(targetDir, `${shas.join("\n")}\n`);
  const findings = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl === -1) break;
    const header = buf.slice(i, nl).toString("utf8");
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!m) {
      i = nl + 1;
      continue;
    }
    const size = Number(m[2]);
    const contentStart = nl + 1;
    const contentEnd = contentStart + size;
    const path = blobs.get(m[1]) ?? m[1];
    if (!ENV_FILE_RE.test(path)) {
      const text = buf.slice(contentStart, contentEnd).toString("utf8");
      for (const f of scanText(text, patterns)) {
        findings.push({ ...f, file: path });
      }
    }
    i = contentEnd + 1;
  }
  return { findings };
}

export async function checkSecrets({ targetDir = process.cwd(), history = false, log = () => {} } = {}) {
  if (!(await isGitRepo(targetDir))) {
    log("Não é um repositório git — nada a auditar.");
    return { notGit: true, findings: [], envFindings: [], historyFindings: [], high: 0, warnings: 0, blocked: false };
  }

  const { patterns, ignore } = await loadConfig({ targetDir });
  const { findings, envFindings } = await scanWorkingTree({ targetDir, patterns, ignore });
  const historyFindings = history ? (await scanHistory({ targetDir, patterns })).findings : [];

  const envHigh = envFindings.length;
  const treeHigh = findings.filter((f) => f.confidence === "high").length;
  const treeWarn = findings.filter((f) => f.confidence === "low").length;
  const histHigh = historyFindings.filter((f) => f.confidence === "high").length;
  const histWarn = historyFindings.filter((f) => f.confidence === "low").length;

  const high = envHigh + treeHigh + histHigh;
  const warnings = treeWarn + histWarn;

  log(`Segredos auditados: ${targetDir}`);
  log(`Working tree: ${treeHigh} alto(s), ${treeWarn} aviso(s)`);
  if (envHigh > 0) {
    log(`${envHigh} ficheiro(s) .env versionado(s):`);
    for (const f of envFindings) log(`  - ${f.file}`);
  }
  for (const f of [...findings].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))) {
    log(`  ${f.file}:${f.line} [${f.label}] (${f.confidence}) ${f.snippet}`);
  }
  if (history) {
    log(`Histórico git: ${histHigh} alto(s), ${histWarn} aviso(s)`);
    for (const f of [...historyFindings].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))) {
      log(`  ${f.file}:${f.line} [${f.label}] (${f.confidence}) ${f.snippet}`);
    }
  }

  if (high > 0) {
    log("\nAchados de alta confiança: corrige o working tree e, para histórico, corre:");
    log("  npx loop-development secrets purge");
  }
  if (warnings > 0) log("\nAvisos de baixa confiança: revê manualmente (não bloqueiam).");

  return { notGit: false, findings, envFindings, historyFindings, high, warnings, blocked: high > 0 };
}

export async function purgeSecrets({ targetDir = process.cwd(), tool = "filter-repo", dryRun = false, log = () => {} } = {}) {
  const { patterns } = await loadConfig({ targetDir });
  const { findings } = await scanHistory({ targetDir, patterns });
  const files = [...new Set(findings.map((f) => f.file))];
  if (files.length === 0) {
    log("Nenhum segredo detetado no histórico — nada a purgar.");
    return { purged: false, files: [] };
  }

  if (dryRun) {
    log("Purga (dry-run) — ficheiros com segredos no histórico:");
    for (const f of files) log(`  - ${f}`);
    return { purged: false, files, dryRun: true };
  }

  if (tool === "filter-branch") {
    log("Purga com filter-branch não é executada automaticamente. Passos recomendados:");
    for (const f of files) {
      log(`  git filter-branch --force --index-filter "git rm --cached --ignore-unmatch '${f}'" --prune-empty --tag-name-filter cat -- --all`);
    }
    log("  git for-each-ref --format='delete %(refname)' refs/original | git update-ref --stdin");
    log("  git reflog expire --expire=now --all && git gc --prune=now --aggressive");
    log("NOTA: faz força-push e ROTACIONA os segredos (a reescrita não invalida credenciais).");
    return { purged: false, files, tool: "filter-branch", manual: true };
  }

  try {
    await execFileAsync("git", ["filter-repo", "--version"], { cwd: targetDir });
  } catch {
    log("git filter-repo não está instalado. Instala com: pip install git-filter-repo  (ou tenta --tool filter-branch para instruções).");
    return { purged: false, files, error: "filter-repo-missing" };
  }

  const args = ["filter-repo", "--force", "--invert-paths", ...files.flatMap((f) => ["--path", f])];
  await execFileAsync("git", args, { cwd: targetDir, maxBuffer: 512 * 1024 * 1024 });
  log("Histórico reescrito com git filter-repo.");
  log(`Ficheiros removidos: ${files.length}`);
  log("NOTA: faz força-push do histórico e ROTACIONA os segredos (a reescrita não invalida credenciais).");
  return { purged: true, files };
}

export async function envGitignoreStatus({ targetDir = process.cwd() } = {}) {
  const ignoreFile = join(targetDir, ".gitignore");
  let content = "";
  try {
    content = await readFile(ignoreFile, "utf8");
  } catch {
    return { hasEnvIgnore: false, trackedEnvFiles: [] };
  }
  const lines = content.split(/\r?\n/);
  const hasEnvIgnore = lines.some((l) => {
    const t = l.trim();
    return t === ".env" || t === ".env*" || t === "*.env" || t === ".env.*" || t === "*.env.*" || t === ".env.local" || t === ".env.example";
  });
  const trackedEnvFiles = (await listTrackedFiles(targetDir)).filter((f) => ENV_FILE_RE.test(f) && !f.endsWith(".env.example"));
  return { hasEnvIgnore, trackedEnvFiles };
}

export function buildEnvGitignoreEntries() {
  return [".env", ".env.*", "!*.env.example"];
}
