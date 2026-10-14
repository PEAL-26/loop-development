import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTar, extractSubtree, detectRootDir, isUnsafeEntryName, gunzip, TarError } from "../src/tar.js";
import { makeTar, makeTarball, paxRecord } from "./helpers/tar.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-tar-"));
}

test("parseTar lê ficheiros, ignora directórios e devolve os dados", () => {
  const tar = makeTar([
    { name: "repo-main/", typeflag: "5" },
    { name: "repo-main/SKILL.md", data: "---\nname: x\n---\n" },
    { name: "repo-main/references/general/security.md", data: "# 5 pilares" },
  ]);
  const { entries } = parseTar(tar);
  assert.deepEqual(entries.map((e) => e.name), ["repo-main/SKILL.md", "repo-main/references/general/security.md"]);
  assert.equal(entries[1].data.toString("utf8"), "# 5 pilares");
});

test("parseTar devolve mode e size", () => {
  const { entries } = parseTar(makeTar([{ name: "a/b.md", data: "12345" }]));
  assert.equal(entries[0].size, 5);
  assert.equal(entries[0].mode, 0o644);
});

test("parseTar descarta symlinks e hardlinks com aviso", () => {
  const tar = makeTar([
    { name: "repo/real.md", data: "x" },
    { name: "repo/link.md", typeflag: "2", data: "/etc/passwd" },
    { name: "repo/hard.md", typeflag: "1", data: "repo/real.md" },
  ]);
  const { entries, warnings } = parseTar(tar);
  assert.deepEqual(entries.map((e) => e.name), ["repo/real.md"]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes("tipo '2'")));
  assert.ok(warnings.some((w) => w.includes("tipo '1'")));
});

test("parseTar lê o prefixo GNU do nome", () => {
  const tar = makeTar([{ name: "componente.tsx", data: "x", prefix: "project-rules/references/frontend" }]);
  const { entries } = parseTar(tar);
  assert.equal(entries[0].name, "project-rules/references/frontend/componente.tsx");
});

test("parseTar aplica cabeçalhos pax (path e size)", () => {
  const tar = makeTar([
    { name: "PaxHeaders/project-rules", typeflag: "x", data: paxRecord("path", "repo-main/renamed.md") },
    { name: "repo-main/original.md", data: "conteudo" },
  ]);
  const { entries } = parseTar(tar);
  assert.equal(entries[0].name, "repo-main/renamed.md");
  assert.equal(entries[0].data.toString("utf8"), "conteudo");
});

test("parseTar recusa entradas truncadas", () => {
  const tar = makeTar([{ name: "a.md", data: "x".repeat(600) }]);
  assert.throws(() => parseTar(tar.subarray(0, 512 + 200)), TarError);
});

test("parseTar impõe limites de entradas e de tamanho", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.md`, data: "x" }));
  assert.throws(() => parseTar(makeTar(many), { maxEntries: 5 }), /mais de 5 entradas/);
  assert.throws(() => parseTar(makeTar(many), { maxTotalBytes: 4 }), /limite de tamanho/);
  assert.throws(() => parseTar(makeTar(many), { maxEntryBytes: 0 }), /demasiado grande/);
});

test("isUnsafeEntryName rejeita traversal, absolutos e barras invertidas", () => {
  assert.equal(isUnsafeEntryName("references/general/security.md"), false);
  assert.equal(isUnsafeEntryName("../evil.md"), true);
  assert.equal(isUnsafeEntryName("a/../../evil.md"), true);
  assert.equal(isUnsafeEntryName("/etc/passwd"), true);
  assert.equal(isUnsafeEntryName("..\\evil.md"), true);
  assert.equal(isUnsafeEntryName("a/./b.md"), true);
  assert.equal(isUnsafeEntryName(""), true);
  assert.equal(isUnsafeEntryName("C:/Windows/system32"), true, "uma letra de drive conta como caminho absoluto");
});

test("detectRootDir deriva a raiz das entradas", () => {
  assert.equal(detectRootDir(["peal-skills-main/project-rules/SKILL.md"]), "peal-skills-main");
  assert.equal(detectRootDir(["SKILL.md"]), "");
  assert.equal(detectRootDir([]), "");
});

test("extractSubtree extrai só a subpasta pedida e remove o prefixo", async () => {
  const dir = tempDir();
  const tarball = makeTarball([
    { name: "peal-skills-main/README.md", data: "# repo" },
    { name: "peal-skills-main/project-rules/SKILL.md", data: "---\nname: project-rules\n---" },
    { name: "peal-skills-main/project-rules/references/general/security.md", data: "# pilares" },
  ]);
  const plain = await gunzip(tarball);
  const result = await extractSubtree(plain, { subpath: "project-rules", destDir: dir });

  assert.deepEqual(result.files.map((f) => f.path), ["SKILL.md", "references/general/security.md"]);
  assert.equal(result.skipped, 1, "o README do repo não é extraído");
  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), "---\nname: project-rules\n---");
  assert.equal(readFileSync(join(dir, "references", "general", "security.md"), "utf8"), "# pilares");
  assert.ok(!existsSync(join(dir, "README.md")));
});

test("extractSubtree recusa escrever fora do destino", async () => {
  const dir = tempDir();
  const tarball = makeTarball([
    { name: "repo-main/project-rules/ok.md", data: "bom" },
    { name: "repo-main/project-rules/../../escapou.md", data: "mau" },
  ]);
  const plain = await gunzip(tarball);
  const result = await extractSubtree(plain, { subpath: "project-rules", destDir: dir });

  assert.deepEqual(result.files.map((f) => f.path), ["ok.md"]);
  assert.ok(result.warnings.some((w) => w.includes("caminho inseguro")));
  assert.equal(existsSync(join(dir, "..", "escapou.md")), false);
});

test("extractSubtree falha quando a subpasta não existe", async () => {
  const dir = tempDir();
  const plain = await gunzip(makeTarball([{ name: "repo-main/README.md", data: "# repo" }]));
  await assert.rejects(() => extractSubtree(plain, { subpath: "project-rules", destDir: dir }), /não contém a subpasta/);
});

test("gunzip propaga o erro do zlib", async () => {
  await assert.rejects(() => gunzip(Buffer.from("isto não é gzip")), TarError);
});

test("os ficheiros extraídos são legíveis e o directório fica limpo", async () => {
  const dir = tempDir();
  const plain = await gunzip(
    makeTarball([
      { name: "r/project-rules/SKILL.md", data: "a" },
      { name: "r/project-rules/references/general/git-workflow.md", data: "b" },
    ]),
  );
  await extractSubtree(plain, { subpath: "project-rules", destDir: dir });
  mkdirSync(join(dir, "vazio"), { recursive: true });
  rmSync(join(dir, "vazio"), { recursive: true, force: true });
  assert.equal(existsSync(join(dir, "SKILL.md")), true);
  assert.equal(readFileSync(join(dir, "references/general/git-workflow.md"), "utf8"), "b");
});
