import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectPackageManager } from "./presets.js";

export const PACKAGE_NAME = "loop-development";

// Dependências necessárias a typecheck/testes. Deliberadamente não são todas as
// devDependencies: semantic-release é pesado e não é preciso para verificar o
// código. Os plugins em si NÃO têm dependências de runtime — importam apenas
// tipos de @opencode/plugin, que o transpiler apaga. É por isso que a pasta de
// config do OpenCode nunca precisa de node_modules.
export const VERIFY_DEPS = ["@opencode/plugin", "typescript", "@types/node"];

export async function readPackage(root) {
  try {
    return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

// Um checkout de desenvolvimento é um directório cujo package.json é o nosso.
// Noutro contexto (cache do npx, instalação global) não há nada a verificar — e
// dizer "tudo OK" seria mentira, porque o npx já traz node_modules de produção.
export async function resolveTarget(cwd) {
  const pkg = await readPackage(cwd);
  return { cwd, isDevCheckout: pkg?.name === PACKAGE_NAME, pkg };
}

export async function missingDeps(root, deps = VERIFY_DEPS) {
  const missing = [];
  for (const name of deps) {
    if (!existsSync(join(root, "node_modules", ...name.split("/"), "package.json"))) missing.push(name);
  }
  return missing;
}

export function runInstall({ bin, args, cwd, dryRun = false, log = () => {} }) {
  return new Promise((resolve, reject) => {
    if (dryRun) {
      log(`(dry-run) ${bin} ${args.join(" ")} em ${cwd}`);
      return resolve(0);
    }
    const child = spawn(bin, args, {
      cwd,
      stdio: "inherit",
      // No Windows os package managers são executáveis .cmd. Desde o
      // CVE-2024-27980 o Node recusa lançá-los sem shell, por isso activamos
      // apenas aí (o repo já fazia spawn de git, que é .exe e funciona sem isto).
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function ensureDeps({
  cwd = process.cwd(),
  fix = false,
  dryRun = false,
  deps = VERIFY_DEPS,
  log = () => {},
} = {}) {
  const target = await resolveTarget(cwd);
  if (!target.isDevCheckout) {
    return {
      cwd,
      isDevCheckout: false,
      checked: [],
      missing: [],
      undeclared: [],
      installed: false,
      ok: true,
    };
  }

  const declared = new Set([
    ...Object.keys(target.pkg.dependencies ?? {}),
    ...Object.keys(target.pkg.devDependencies ?? {}),
  ]);
  const undeclared = deps.filter((d) => !declared.has(d));
  let missing = await missingDeps(target.cwd, deps);

  if (missing.length === 0) {
    return { cwd, isDevCheckout: true, checked: deps, missing: [], undeclared, installed: false, ok: true };
  }

  if (!fix) {
    return { cwd, isDevCheckout: true, checked: deps, missing, undeclared, installed: false, ok: false };
  }

  const pm = (await detectPackageManager(target.cwd)) ?? "npm";
  log(`dependências em falta: ${missing.join(", ")} — a instalar com ${pm}`);
  const code = await runInstall({ bin: pm, args: ["install"], cwd: target.cwd, dryRun, log });
  if (code !== 0) {
    return { cwd, isDevCheckout: true, checked: deps, missing, undeclared, installed: false, ok: false, error: `${pm} install saiu com código ${code}` };
  }

  missing = await missingDeps(target.cwd, deps);
  return {
    cwd,
    isDevCheckout: true,
    checked: deps,
    missing,
    undeclared,
    installed: missing.length === 0,
    ok: missing.length === 0,
  };
}