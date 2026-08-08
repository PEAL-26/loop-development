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

export const EXECUTION_AGENTS = [
  "implementer",
  "refactorer",
  "test-writer",
  "verifier",
  "dependency-auditor",
  "security-auditor",
  "performance-auditor"
];

export const STALE_AGENT_KEYS = ["implementer", "verifier", "loop-triage"];
