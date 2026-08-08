import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const PROJECT_LEVEL_FILES = ["architecture.md", "changelog.md", "project-summary.md", "risks.md"];
const LEGACY_PLAN_FILES = {
  "roadmap.md": "spec.md",
  "decisions.md": "decisions.md",
  "implementation-log.md": "implementation-log/index.md"
};
const LEGACY_PLAN_DIRS = { tickets: "tasks", summaries: "summaries", metrics: "metrics" };

function now() {
  return new Date();
}

export function timestampPrefix(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function slugify(name) {
  const slug = String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "plano";
}

export function planId(date, slug) {
  return `${timestampPrefix(date)}-${slugify(slug)}`;
}

export function currentMonthShard(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export function detectLegacyLayout(targetDir) {
  const root = join(targetDir, ".loop-development");
  if (!existsSync(root)) return false;
  if (existsSync(join(root, "plans"))) return false;
  const state = readJsonSync(join(root, "state.json"));
  return !state || state.version !== 2;
}

function readJsonSync(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeScaffoldPlan(dir, date, log) {
  await mkdir(dir, { recursive: true });
  const shard = currentMonthShard(date);
  const planState = {
    phase: "intake",
    current_task: null,
    tasks_done: [],
    tasks_pending: [],
    last_updated: date.toISOString()
  };
  await writeFile(join(dir, "state.json"), JSON.stringify(planState, null, 2) + "\n", "utf8");
  await writeFile(join(dir, "spec.md"), "# Especificação\n\n> Preenchido pelo Planner Writer após aprovação do plano.\n", "utf8");
  await writeFile(join(dir, "decisions.md"), "# Decisões técnicas do plano\n\n> ADRs curtos: contexto, decisão, alternativas consideradas, consequências.\n", "utf8");
  await mkdir(join(dir, "implementation-log"), { recursive: true });
  await writeFile(join(dir, "implementation-log", "index.md"), "# Log de implementação — índices\n\n| Mês | Ficheiro |\n|---|---|\n", "utf8");
  await writeFile(join(dir, "implementation-log", `${shard}.md`), `# Log de implementação — ${shard}\n\n> Log cronológico. Uma entrada por tarefa concluída, mais o pedido inicial registado pelo Intake.\n`, "utf8");
  await mkdir(join(dir, "tasks"), { recursive: true });
  await mkdir(join(dir, "summaries"), { recursive: true });
  await mkdir(join(dir, "metrics"), { recursive: true });
  if (log) log(`plano criado: ${dir}`);
}

export async function scaffoldPlan({ targetDir = process.cwd(), slug = "plano", date = new Date(), log = () => {} } = {}) {
  const id = planId(date, slug);
  const dir = join(targetDir, ".loop-development", "plans", id);
  await writeScaffoldPlan(dir, date, log);
  return { id, dir };
}

async function moveIfExists(src, dst) {
  if (!existsSync(src)) return false;
  await rename(src, dst);
  return true;
}

async function ensureProjectState(targetDir, legacyState, planIdValue, date) {
  const root = join(targetDir, ".loop-development");
  const projectState = {
    version: 2,
    active_plan: planIdValue,
    plans: [
      {
        id: planIdValue,
        name: "projeto-inicial",
        status: legacyState?.phase === "done" || legacyState?.phase === "final-review" ? "done" : "in-progress",
        created_at: legacyState?.created_at ?? date.toISOString(),
        last_updated: legacyState?.last_updated ?? date.toISOString()
      }
    ],
    min_coverage: legacyState?.min_coverage ?? 80,
    created_at: legacyState?.created_at ?? date.toISOString(),
    last_updated: date.toISOString()
  };
  await writeFile(join(root, "state.json"), JSON.stringify(projectState, null, 2) + "\n", "utf8");
}

export async function migrateProject({ targetDir = process.cwd(), dryRun = false, log = () => {} } = {}) {
  const root = join(targetDir, ".loop-development");
  if (!existsSync(root)) {
    throw new Error(`Sem .loop-development/ em ${targetDir} — nada a migrar.`);
  }
  if (!detectLegacyLayout(targetDir)) {
    log("Estrutura já está no formato por planos (ou sem plans/ para migrar). Nada a fazer.");
    return { id: null, migrated: false };
  }

  const date = now();
  const id = planId(date, "projeto-inicial");
  const planDir = join(root, "plans", id);
  const legacyState = readJsonSync(join(root, "state.json"));

  if (dryRun) {
    log(`migração (dry-run): plans/${id}/ receberia roadmap.md→spec.md, implementation-log.md, decisions.md, tickets/→tasks/, summaries/, metrics/.`);
    return { id, migrated: true, dryRun: true };
  }

  await mkdir(planDir, { recursive: true });
  await mkdir(join(planDir, "implementation-log"), { recursive: true });

  const moves = [];
  for (const [src, dst] of Object.entries(LEGACY_PLAN_FILES)) {
    const from = join(root, src);
    if (!existsSync(from)) continue;
    if (dst === "implementation-log/index.md") {
      await rename(from, join(planDir, "implementation-log", `${currentMonthShard(date)}.md`));
      await writeFile(join(planDir, "implementation-log", "index.md"), `# Log de implementação — índices\n\n| Mês | Ficheiro |\n|---|---|\n| ${currentMonthShard(date)} | ${currentMonthShard(date)}.md |\n`, "utf8");
    } else {
      await rename(from, join(planDir, dst));
    }
    moves.push(`${src} → ${dst}`);
  }
  for (const [src, dst] of Object.entries(LEGACY_PLAN_DIRS)) {
    const from = join(root, src);
    if (existsSync(from)) await rename(from, join(planDir, dst));
  }

  const planState = {
    phase: legacyState?.phase ?? "intake",
    current_task: legacyState?.current_ticket ?? legacyState?.current_task ?? null,
    tasks_done: legacyState?.tickets_done ?? legacyState?.tasks_done ?? [],
    tasks_pending: legacyState?.tickets_pending ?? legacyState?.tasks_pending ?? [],
    last_updated: date.toISOString()
  };
  await writeFile(join(planDir, "state.json"), JSON.stringify(planState, null, 2) + "\n", "utf8");
  await ensureProjectState(targetDir, legacyState, id, date);

  log(`Estrutura antiga convertida para o plano ${id}.`);
  for (const m of moves) log(`  movido: ${m}`);
  log("Arquitetura, changelog, project-summary e risks ficaram no nível de projeto.");
  return { id, migrated: true };
}
