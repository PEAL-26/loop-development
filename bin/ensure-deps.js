#!/usr/bin/env node
// Gatilho npm `prepare`. Garante que as dependências de verificação (typecheck,
// testes) estão instaladas, instalando-as em falta.
//
// Nunca falha a instalação: um ambiente offline, sem rede ou sem permissões não
// pode impedir o utilizador de instalar o pacote. Por isso o exit code é sempre
// 0 e os problemas são apenas reportados.
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ensureDeps } from "../src/deps.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const log = (message) => console.log(`[deps] ${message}`);

try {
  const result = await ensureDeps({ cwd: root, fix: true, log });
  if (result.isDevCheckout && result.missing.length > 0) {
    console.warn(`[deps] ainda em falta: ${result.missing.join(", ")}`);
  }
  if (result.isDevCheckout && result.undeclared.length > 0) {
    console.warn(`[deps] não declaradas no package.json: ${result.undeclared.join(", ")}`);
  }
} catch (err) {
  console.warn(`[deps] verificação de dependências falhou: ${err.message}`);
}

process.exitCode = 0;