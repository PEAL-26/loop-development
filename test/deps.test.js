import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PACKAGE_NAME,
  VERIFY_DEPS,
  readPackage,
  resolveTarget,
  missingDeps,
  runInstall,
  ensureDeps,
} from "../src/deps.js";
import { PKG_ROOT } from "../src/install.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-deps-"));
}

// Escreve um package.json e devolve a raiz, para simular um checkout de
// desenvolvimento (ou outro pacote qualquer).
function writePkg(root, pkg) {
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  return root;
}

// Marca um pacote como instalado criando node_modules/<nome>/package.json.
function fakeInstalled(root, names) {
  for (const name of names) {
    const dir = join(root, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }), "utf8");
  }
  return root;
}

// Um "package manager" falso que só existe no cwd do checkout e sai com código 3.
// Só é resolvível pelo shell a partir do directório actual — noutros sistemas
// teria de estar no PATH, por isso o teste salta.
function fakePackageManager(root, name) {
  writeFileSync(join(root, `${name}.cmd`), "@exit /b 3\r\n", "ascii");
}

test("PACKAGE_NAME e VERIFY_DEPS estão declarados no package.json do repo", async () => {
  // As dependências de verificação são exactamente as do plano (§4.5): o que o
  // typecheck e os testes precisam, e nada mais. O comentário em src/deps.js
  // diz que semantic-release é excluído de propósito — este teste fixa isso.
  assert.equal(PACKAGE_NAME, "loop-development");
  assert.deepEqual(VERIFY_DEPS, ["@opencode/plugin", "typescript", "@types/node"]);

  const pkg = await readPackage(PKG_ROOT);
  const declared = Object.keys(pkg.devDependencies);
  for (const dep of VERIFY_DEPS) {
    assert.ok(declared.includes(dep), `${dep} tem de estar em devDependencies`);
  }
  assert.deepEqual(VERIFY_DEPS.filter((d) => !declared.includes(d)), []);
});

test("readPackage lê o package.json e devolve null em caso de erro", async () => {
  const root = writePkg(tempDir(), { name: PACKAGE_NAME, version: "1.2.3" });
  assert.deepEqual(await readPackage(root), { name: PACKAGE_NAME, version: "1.2.3" });

  // Sem package.json não é erro: quem chama decide o que fazer com o null.
  assert.equal(await readPackage(tempDir()), null);

  // JSON inválido também é null, não uma excepção.
  const broken = tempDir();
  writeFileSync(join(broken, "package.json"), "{isto não é json", "utf8");
  assert.equal(await readPackage(broken), null);
});

test("resolveTarget reconhece o checkout de desenvolvimento", async () => {
  const root = writePkg(tempDir(), { name: PACKAGE_NAME, version: "1.0.0" });
  const target = await resolveTarget(root);
  assert.equal(target.isDevCheckout, true);
  assert.equal(target.cwd, root);
  assert.equal(target.pkg.name, PACKAGE_NAME);
});

test("resolveTarget trata qualquer outro package.json como instalação fora do checkout", async () => {
  // Cache do npx ou instalação global: o nome é outro e não há nada a
  // verificar — dizer que está tudo OK seria mentira.
  const root = writePkg(tempDir(), { name: "algum-outro-pacote", version: "9.9.9" });
  const target = await resolveTarget(root);
  assert.equal(target.isDevCheckout, false);
  assert.equal(target.pkg.name, "algum-outro-pacote");
});

test("resolveTarget sem package.json não é checkout de desenvolvimento", async () => {
  const target = await resolveTarget(tempDir());
  assert.equal(target.isDevCheckout, false);
  assert.equal(target.pkg, null);
});

test("missingDeps lista o que não está em node_modules", async () => {
  const root = tempDir();
  // Sem node_modules, tudo falta.
  assert.deepEqual(await missingDeps(root), VERIFY_DEPS);

  // Pacotes com scope também contam (node_modules/@types/node/package.json).
  fakeInstalled(root, ["@opencode/plugin"]);
  assert.deepEqual(await missingDeps(root), ["typescript", "@types/node"]);

  fakeInstalled(root, ["typescript", "@types/node"]);
  assert.deepEqual(await missingDeps(root), []);

  // Só olha ao que foi pedido.
  assert.deepEqual(await missingDeps(root, ["typescript"]), []);
  assert.deepEqual(await missingDeps(root, ["outra-coisa"]), ["outra-coisa"]);
});

test("ensureDeps com fix:false reporta as que faltam sem instalar", async () => {
  const root = writePkg(tempDir(), {
    name: PACKAGE_NAME,
    devDependencies: { "@opencode/plugin": "^2.0.0", typescript: "^5.6.0", "@types/node": "^22.0.0" },
  });
  fakeInstalled(root, ["typescript"]);

  const result = await ensureDeps({ cwd: root, fix: false });

  assert.equal(result.isDevCheckout, true);
  assert.equal(result.ok, false);
  assert.equal(result.installed, false);
  assert.deepEqual(result.checked, VERIFY_DEPS);
  assert.deepEqual(result.missing, ["@opencode/plugin", "@types/node"]);
  assert.deepEqual(result.undeclared, [], "tudo o que verificamos está declarado");
  // Nada foi instalado: sem --fix o comando só reporta.
  assert.equal(existsSync(join(root, "node_modules", "@types")), false);
});

test("ensureDeps assinala dependências usadas mas não declaradas", async () => {
  // Não declarada é um aviso, não uma falha — o que o plano (§4.5) exige é que
  // faltando-as sejam instaladas, não que constem do package.json.
  const root = writePkg(tempDir(), { name: PACKAGE_NAME, devDependencies: { typescript: "^5.6.0" } });
  fakeInstalled(root, VERIFY_DEPS);

  const result = await ensureDeps({ cwd: root, fix: false });

  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.installed, false);
  assert.deepEqual(result.undeclared, ["@opencode/plugin", "@types/node"]);
});

test("ensureDeps passa quando as dependências já estão instaladas", async () => {
  const root = writePkg(tempDir(), { name: PACKAGE_NAME });
  fakeInstalled(root, VERIFY_DEPS);

  const result = await ensureDeps({ cwd: root });

  assert.equal(result.ok, true);
  assert.equal(result.isDevCheckout, true);
  assert.deepEqual(result.checked, VERIFY_DEPS);
  assert.deepEqual(result.missing, []);
  assert.equal(result.installed, false, "não instalou nada porque não era preciso");
});

test("ensureDeps fora de um checkout de desenvolvimento responde ok sem verificar", async () => {
  // Numa instalação via npx o node_modules de produção já vem com o pacote:
  // dizer ok sem verificar é o comportamento correcto, não uma mentira.
  const root = writePkg(tempDir(), { name: "outro-pacote", version: "1.0.0" });

  const result = await ensureDeps({ cwd: root });

  assert.equal(result.isDevCheckout, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.checked, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.undeclared, []);
  assert.equal(result.installed, false);
  assert.equal(existsSync(join(root, "node_modules")), false, "nem sequer olha para node_modules");
});

test("ensureDeps fora de um checkout de desenvolvimento não instala com fix", async () => {
  // Aqui fix:true é seguro: sem dependências em falta o runInstall nunca é
  // chamado, nem com um gestor de pacotes real.
  const root = writePkg(tempDir(), { name: "outro-pacote", version: "1.0.0" });
  const logs = [];

  const result = await ensureDeps({ cwd: root, fix: true, log: (m) => logs.push(m) });

  assert.equal(result.ok, true);
  assert.deepEqual(logs, [], "nenhum log de instalação");
  assert.equal(existsSync(join(root, "node_modules")), false);
});

test("runInstall com dryRun:true não lança o package manager", async () => {
  const logs = [];
  // Binário inexistente de propósito: se o dry-run não impedir o spawn, o
  // promise rejeitaria em vez de resolver com 0.
  const code = await runInstall({
    bin: "gestor-de-pacotes-que-nao-existe-xyz",
    args: ["install"],
    cwd: tempDir(),
    dryRun: true,
    log: (m) => logs.push(m),
  });

  assert.equal(code, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\(dry-run\) gestor-de-pacotes-que-nao-existe-xyz install em /);
});

test("ensureDeps com fix e dryRun reporta o que instalaria sem instalar", async () => {
  const root = writePkg(tempDir(), { name: PACKAGE_NAME });
  const logs = [];

  const result = await ensureDeps({ cwd: root, fix: true, dryRun: true, log: (m) => logs.push(m) });

  // A instalação foi só simulada, portanto as dependências continuam em falta e
  // o comando não pode declarar sucesso.
  assert.equal(result.ok, false);
  assert.equal(result.installed, false);
  assert.deepEqual(result.missing, VERIFY_DEPS);
  assert.match(logs.join("\n"), /a instalar com npm/);
  assert.match(logs.join("\n"), /\(dry-run\) npm install /);
  assert.equal(existsSync(join(root, "node_modules")), false, "nada foi instalado");
});

test("ensureDeps usa o package manager detectado no checkout", async () => {
  const root = writePkg(tempDir(), { name: PACKAGE_NAME });
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  const logs = [];

  await ensureDeps({ cwd: root, fix: true, dryRun: true, log: (m) => logs.push(m) });

  assert.match(logs.join("\n"), /a instalar com pnpm/);
  assert.match(logs.join("\n"), /\(dry-run\) pnpm install /);
});

test("ensureDeps não declara sucesso se o package manager falhar", async (t) => {
  // Só no Windows: o cmd.exe resolve o executável a partir do directório
  // actual, por isso o "bun" falso abaixo é encontrado sem mexer no PATH.
  if (process.platform !== "win32") return t.skip("o package manager falso precisa de estar no PATH");
  const root = writePkg(tempDir(), { name: PACKAGE_NAME, packageManager: "bun@1.0.0" });
  fakePackageManager(root, "bun");

  const result = await ensureDeps({ cwd: root, fix: true, log: () => {} });

  assert.equal(result.ok, false, "um install falhado não pode dar origem a um 'tudo em ordem'");
  assert.equal(result.installed, false);
  assert.match(result.error, /^bun install saiu com código 3$/);
});
