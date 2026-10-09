export const AGENT_NAME = "loop-development";

export const INTERNAL_AGENTS = [
  "context-loader",
  "state-manager",
  "planner-writer",
  "task-generator",
  "compacter",
  "refactorer",
  "documentation-writer",
  "final-reviewer"
];

export const INTERNAL_READ_AGENTS = [
  "implementer",
  "test-writer",
  "git-manager"
];

// Acções de permissão (nomes V2). `edit` cobre edit/write/patch.
export const PERMISSION_KEYS = ["read", "edit", "glob"];

// Renomeações de acção V1 → V2 aplicadas na migração do config.
export const ACTION_RENAMES = {
  bash: "shell",
  task: "subagent",
  write: "edit",
  patch: "edit"
};

// Agentes cujo bash per-agent era gerido pelo installer em versões antigas
// (necessário para a migração remover essas regras e o default global valer).
export const OBSOLETE_BASH_AGENTS = [
  "implementer",
  "refactorer",
  "test-writer",
  "verifier",
  "dependency-auditor",
  "security-auditor",
  "performance-auditor"
];

export const STALE_AGENT_KEYS = ["implementer", "verifier", "loop-triage"];

// Grants de acesso ao projeto, como regras ordenadas de permissão. Espelham os
// defaults do opencode para .env: a regra broad "*" allow vem primeiro e as
// excepções específicas depois, porque no V2 vale a última regra que casa.
export function projectGrantRules(action) {
  return [
    { action, resource: "*", effect: "allow" },
    { action, resource: "*.env", effect: "ask" },
    { action, resource: "*.env.*", effect: "ask" },
    { action, resource: "*.env.example", effect: "allow" }
  ];
}

// Agentes que escrevem ficheiros do projeto (código, testes, docs) e recebem
// edit em allow no opencode.json do projeto; os restantes só read/glob.
export const PROJECT_EDIT_AGENTS = ["implementer", "test-writer", "refactorer", "documentation-writer"];