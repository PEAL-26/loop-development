import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ARCHITECTURE_FILE = "architecture.md";

export const REQUIRED_SECTIONS = ["Stack", "Padrões adotados", "Estrutura de pastas", "Decisões relevantes"];

export const CONTENT_SIGNALS = [
  { name: "bloco de código", pattern: /```/g },
  { name: "menção a MVP", pattern: /\bmvp\b/gi },
  { name: "fase do projeto", pattern: /\bfase\b/gi },
  { name: "migração de tarefa", pattern: /\bmigra[çc][aã]o\b|\bmigrate\b/gi },
  { name: "referência a planos", pattern: /plans\//g },
  { name: "referência a tarefas", pattern: /tasks\//g },
  { name: "id de tarefa (M0xx)", pattern: /\bM0\d+\b/g },
  { name: "script SQL", pattern: /\b(CREATE TABLE|INSERT INTO|ALTER TABLE|DROP TABLE|DELETE FROM|SELECT\s+\*)/gi },
  { name: "lista de tarefas/checklist", pattern: /\[[ xX]\]/g },
  { name: "id de plano (timestamp)", pattern: /\b\d{8}\.\d{4}\b/g }
];

function fresh(pattern) {
  return new RegExp(pattern.source, pattern.flags);
}

export function analyzeArchitecture(markdown) {
  const lines = markdown.split(/\r?\n/);
  const violations = [];
  const warnings = [];

  const headers = new Set(
    lines
      .filter((l) => /^##\s+/.test(l))
      .map((l) => l.replace(/^##\s+/, "").trim())
  );

  for (const section of REQUIRED_SECTIONS) {
    if (!headers.has(section)) {
      warnings.push({ section, line: 0 });
    }
  }

  for (const signal of CONTENT_SIGNALS) {
    const re = fresh(signal.pattern);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        violations.push({ signal: signal.name, line: i + 1, snippet: lines[i].trim().slice(0, 120) });
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
  }

  return { violations, warnings };
}

export async function checkArchitecture({ targetDir = process.cwd(), log = () => {} } = {}) {
  const file = join(targetDir, ".loop-development", ARCHITECTURE_FILE);
  let markdown;
  try {
    markdown = await readFile(file, "utf8");
  } catch {
    log(`Sem ${ARCHITECTURE_FILE} em ${join(targetDir, ".loop-development")} — nada a auditar.`);
    return { missing: true, violations: [], warnings: [] };
  }

  const { violations, warnings } = analyzeArchitecture(markdown);
  log(`Arquitetura auditada: ${file}`);
  log(`Violações de conteúdo: ${violations.length}`);
  for (const v of violations) {
    log(`  linha ${String(v.line).padStart(4)} [${v.signal}] ${v.snippet}`);
  }
  if (warnings.length > 0) {
    log(`Secções obrigatórias em falta (aviso):`);
    for (const w of warnings) log(`  - ## ${w.section}`);
  }
  return { missing: false, violations, warnings };
}
