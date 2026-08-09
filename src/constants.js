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

export const PERMISSION_KEYS = ["read", "edit", "glob"];

// Agentes cujo bash per-agent era gerido pelo installer em versões antigas
// (necessário para a migração remover essas chaves e o default global valer).
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

// Mapa de permissões de ficheiros que o installProject grava no opencode.json
// do projeto (read/glob para todos os agentes, edit para quem escreve código).
// Espelha os defaults do opencode para .env: o broad "*" allow vem primeiro e
// as exceções específicas depois — a última regra que casa ganha.
export const PROJECT_GRANT_MAP = {
  "*": "allow",
  "*.env": "ask",
  "*.env.*": "ask",
  "*.env.example": "allow"
};

// Agentes que escrevem ficheiros do projeto (código, testes, docs) e recebem
// edit em allow no opencode.json do projeto; os restantes só read/glob.
export const PROJECT_EDIT_AGENTS = ["implementer", "test-writer", "refactorer", "documentation-writer"];
