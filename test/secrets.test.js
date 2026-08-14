import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { scanText, parseJsonc, loadConfig, checkSecrets, scanWorkingTree, scanHistory, envGitignoreStatus, DEFAULT_PATTERNS } from "../src/secrets.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-sec-"));
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function initRepo(dir) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

test("scanText deteta tokens de alta confiança com linha e redação", () => {
  const text = "linha um\nAPI_KEY=sk-abc1234567890123456789\nlinha três";
  const findings = scanText(text);
  assert.ok(findings.some((f) => f.patternId === "openai-key" && f.confidence === "high" && f.line === 2));
  assert.ok(findings.some((f) => f.patternId === "env-pair-secret" && f.confidence === "high"));
  for (const f of findings) assert.ok(!f.snippet.includes("sk-abc1234567890123456789"));
});

test("scanText deteta chaves privadas e tokens de serviços", () => {
  const text = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-1234567890-abcdefghijklm"
  ].join("\n");
  const ids = scanText(text).map((f) => f.patternId);
  assert.ok(ids.includes("private-key"));
  assert.ok(ids.includes("github-pat"));
  assert.ok(ids.includes("aws-access-key"));
  assert.ok(ids.includes("slack-token"));
});

test("scanText marca JWT e URLs com credenciais como baixa confiança", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz";
  const url = "https://user:password@example.com/db";
  const low = scanText(`${jwt}\n${url}`).filter((f) => f.confidence === "low");
  assert.ok(low.some((f) => f.patternId === "jwt"));
  assert.ok(low.some((f) => f.patternId === "url-credentials"));
});

test("parseJsonc remove comentários e mantém strings", () => {
  const jsonc = `{
    // comentário
    "patterns": ["sk-", /* bloco */ "ghp_"],
    "url": "https://example.com//path"
  }`;
  const parsed = parseJsonc(jsonc);
  assert.deepEqual(parsed.patterns, ["sk-", "ghp_"]);
  assert.equal(parsed.url, "https://example.com//path");
});

test("loadConfig devolve defaults sem config e funde config do projeto", async () => {
  const dir = tempDir();
  const base = await loadConfig({ targetDir: dir });
  assert.equal(base.patterns.length, DEFAULT_PATTERNS.length);

  mkdirSync(join(dir, ".loop-development"), { recursive: true });
  writeFileSync(
    join(dir, ".loop-development", "secret-patterns.jsonc"),
    `{ "patterns": [{ "id": "custom", "label": "meu token", "confidence": "high", "regex": "CUSTOM_SECRET_[A-Z0-9]+" }], "ignore": ["docs/privado/**"] }`,
    "utf8"
  );
  const merged = await loadConfig({ targetDir: dir });
  assert.equal(merged.patterns.length, DEFAULT_PATTERNS.length + 1);
  assert.deepEqual(merged.ignore, ["docs/privado/**"]);
});

test("checkSecrets reporta .env versionado como bloqueante", async () => {
  const dir = tempDir();
  initRepo(dir);
  writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://user:pass@host:5432/db\n", "utf8");
  commitAll(dir, "adiciona .env");
  const logs = [];
  const result = await checkSecrets({ targetDir: dir, log: (s) => logs.push(s) });
  assert.equal(result.notGit, false);
  assert.equal(result.envFindings.length, 1);
  assert.equal(result.envFindings[0].patternId, "env-tracked");
  assert.equal(result.blocked, true);
  assert.ok(result.high >= 1);
});

test("checkSecrets deteta segredo em ficheiro tracked e clean quando ausente", async () => {
  const dir = tempDir();
  initRepo(dir);
  writeFileSync(join(dir, "README.md"), "chave: sk-abcdef1234567890abcdef1234567890\n", "utf8");
  commitAll(dir, "adiciona README com segredo");
  const dirty = await checkSecrets({ targetDir: dir });
  assert.ok(dirty.high >= 1);

  writeFileSync(join(dir, "README.md"), "ok\n", "utf8");
  commitAll(dir, "remove segredo");
  const clean = await checkSecrets({ targetDir: dir });
  assert.equal(clean.high, 0);
});

test("scanHistory deteta segredo removido mas presente em commit antigo", async () => {
  const dir = tempDir();
  initRepo(dir);
  writeFileSync(join(dir, "config.md"), "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n", "utf8");
  commitAll(dir, "adiciona segredo");
  writeFileSync(join(dir, "config.md"), "sem segredo\n", "utf8");
  commitAll(dir, "remove segredo");

  const { findings } = await scanHistory({ targetDir: dir });
  assert.ok(findings.some((f) => f.patternId === "github-pat"));
});

test("envGitignoreStatus reporta se .env está ignorado e rastreado", async () => {
  const dir = tempDir();
  initRepo(dir);
  const none = await envGitignoreStatus({ targetDir: dir });
  assert.equal(none.hasEnvIgnore, false);

  writeFileSync(join(dir, ".gitignore"), ".env\n", "utf8");
  writeFileSync(join(dir, ".env"), "X=1\n", "utf8");
  const status = await envGitignoreStatus({ targetDir: dir });
  assert.equal(status.hasEnvIgnore, true);
  assert.deepEqual(status.trackedEnvFiles, []);
});

test("scanWorkingTree respeita ignore do catálogo", async () => {
  const dir = tempDir();
  initRepo(dir);
  mkdirSync(join(dir, "docs", "privado"), { recursive: true });
  writeFileSync(join(dir, "docs", "privado", "secreto.md"), "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n", "utf8");
  commitAll(dir, "adiciona docs privadas");
  const { findings } = await scanWorkingTree({ targetDir: dir, ignore: ["docs/privado/**"] });
  assert.equal(findings.length, 0);
  const withoutIgnore = await scanWorkingTree({ targetDir: dir });
  assert.ok(withoutIgnore.findings.length >= 1);
});
