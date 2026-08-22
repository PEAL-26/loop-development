import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function readAgent(name) {
  return readFile(join(PKG_ROOT, "opencode", "agents", `${name}.md`), "utf8");
}

test("grill-me define entrevista iterativa e estados explícitos", async () => {
  const content = await readAgent("grill-me");

  assert.match(content, /exatamente uma pergunta/);
  assert.match(content, /não faças uma segunda pergunta na mesma invocação/);
  assert.match(content, /needs_research/);
  assert.match(content, /resolved/);
  assert.match(content, /blocked/);
  assert.match(content, /não escolhas .* sem pesquisa/i);
  assert.match(content, /contradisser uma decisão anterior/);
  assert.match(content, /falta de informação|sem informação nova/i);
});

test("orquestrador não pede aprovação redundante das tarefas", async () => {
  const content = await readAgent("loop-development");

  assert.match(content, /Aprovação automática das tarefas/);
  assert.match(content, /tasks_approval_source: "plan-approval"/);
  assert.match(content, /Não peças uma segunda aprovação/);
  assert.match(content, /alteração de escopo ou decisão nova/);
  assert.doesNotMatch(content, /PARAGEM OBRIGATÓRIA — Aprovação das tarefas/);
});

test("researcher e planner não assumem decisões relevantes", async () => {
  const researcher = await readAgent("researcher");
  const planner = await readAgent("planner");

  assert.match(researcher, /alternativas comparáveis/);
  assert.match(researcher, /Não escolhas/);
  assert.match(planner, /Não assumes decisões relevantes/);
  assert.match(planner, /clarifications\.md/);
});

test("planner-writer aplica o contrato de conteúdo ao architecture.md", async () => {
  const content = await readAgent("planner-writer");

  assert.match(content, /base estrutural do projeto/);
  assert.match(content, /Contrato de conteúdo/);
  assert.match(content, /Não pertence/);
  assert.match(content, /Pertence/);
  assert.match(content, /MVP/);
  assert.match(content, /fase do projeto|roadmap/);
  assert.match(content, /migra|scripts SQL/);
  assert.match(content, /Regra de poda/);
  assert.match(content, /idempotente/);
});

test("documentation-writer nunca edita architecture.md", async () => {
  const content = await readAgent("documentation-writer");
  assert.match(content, /Nunca edites `\.loop-development\/architecture\.md`/);
});

test("final-reviewer verifica o contrato com o architecture check", async () => {
  const content = await readAgent("final-reviewer");
  assert.match(content, /contrato de conteúdo/);
  assert.match(content, /architecture check/);
  assert.match(content, /exit code ≠ 0|exit code/);
});

test("compacter respeita o contrato anti-redundância dos resumos", async () => {
  const content = await readAgent("compacter");

  assert.match(content, /nunca repitas conteúdo|nunca o repete/i);
  assert.match(content, /referencia/);
  assert.match(content, /delta desde o anterior|delta/);
  assert.match(content, /anterior:/);
  assert.match(content, /index\.md/);
  assert.match(content, /fonte única da verdade/i);
});

test("context-loader lê o resumo mais recente como contexto de retoma", async () => {
  const content = await readAgent("context-loader");

  assert.match(content, /summaries\/index\.md/);
  assert.match(content, /resumo \*\*mais recente\*\*|mais recente/);
  assert.match(content, /não são fonte de verdade|não é fonte de verdade/);
});

test("state-manager regista implementation-log enxuto e faz rotação de summaries", async () => {
  const content = await readAgent("state-manager");

  assert.match(content, /Rotação de summaries|rotação/);
  assert.match(content, /metrics\/<task-id>\.json/);
  assert.match(content, /não re-descrevas|sem repetir decisões|nunca repete decisões/i);
});

test("documentation-writer não duplica decisões no changelog nem nos ADRs", async () => {
  const content = await readAgent("documentation-writer");

  assert.match(content, /1 linha|1 linha do que mudou/);
  assert.match(content, /Nunca dupliques|nunca dupliques/);
  assert.match(content, /decisions\.md/);
});

test("planner-writer não duplica clarifications em decisions.md", async () => {
  const content = await readAgent("planner-writer");

  assert.match(content, /nunca duplica.*clarifications|não duplica.*clarifications/);
  assert.match(content, /referencia as clarificações|referenciam as clarificações/);
});

test("final-reviewer reporta pendências de redundância em summaries/logs", async () => {
  const content = await readAgent("final-reviewer");

  assert.match(content, /Redundância/);
  assert.match(content, /summaries/);
  assert.match(content, /pendências acionáveis/);
});

test("agentes que escrevem ficheiros proíbem valores de env vars (M004)", async () => {
  const writing = ["implementer", "documentation-writer", "planner-writer", "compacter", "state-manager", "test-writer", "refactorer"];
  for (const name of writing) {
    const content = await readAgent(name);
    assert.match(content, /Segredos e variáveis de ambiente/, `${name} deve ter secção de segredos`);
    assert.match(content, /nunca (escrevas|documentes) valores reais/i, `${name} deve proibir valores reais de env vars`);
  }
});

test("security-auditor e final-reviewer usam o secrets check (M004)", async () => {
  const sa = await readAgent("security-auditor");
  assert.match(sa, /secrets check/);
  assert.match(sa, /alta confiança/);
  assert.match(sa, /bloqueante|bloquear/);
  const fr = await readAgent("final-reviewer");
  assert.match(fr, /secrets check/);
  assert.match(fr, /alta confiança/);
});

test("verifier distingue modo tarefa e modo plano (M005)", async () => {
  const content = await readAgent("verifier");
  assert.match(content, /tarefa.*plano|plano.*tarefa/);
  assert.match(content, /Modo tarefa/);
  assert.match(content, /Modo plano/);
  assert.match(content, /git diff HEAD/);
  assert.match(content, /test-affected/);
  assert.match(content, /per_task/);
  assert.match(content, /`final`/);
  assert.match(content, /Build/);
  assert.match(content, /Cobertura mínima/);
  assert.match(content, /min_coverage/);
});

test("orquestrador tem verificação final antes do Final Reviewer (M005)", async () => {
  const content = await readAgent("loop-development");
  assert.match(content, /Verificação final do plano/);
  assert.match(content, /modo `plano`/);
  assert.match(content, /testes afetados/);
  assert.match(content, /Nunca.*build nem a suite completa/);
  assert.match(content, /fix commits/);
  assert.match(content, /sem amend nem rebase/);
});

test("final-reviewer não re-executa build nem suite completa (M005)", async () => {
  const content = await readAgent("final-reviewer");
  assert.match(content, /verificação final do plano/);
  assert.match(content, /não re-executas/);
});

test("test-writer cria/atualiza o guia de teste manual (M007)", async () => {
  const content = await readAgent("test-writer");

  assert.match(content, /manual-testing\.md/);
  assert.match(content, /Onde entrar/);
  assert.match(content, /Passos/);
  assert.match(content, /Configurações/);
  assert.match(content, /Resultado esperado/);
  assert.match(content, /Verificação via CLI\/API/);
  assert.match(content, /Toda a tarefa tem secção/);
  assert.match(content, /Sem teste manual/);
  assert.match(content, /coberto por testes automatizados/);
  assert.match(content, /tasks\/<task-id>\.md/);
  assert.match(content, /Como executar o projeto/);
});

test("git-manager inclui o manual-testing.md no commit (M007)", async () => {
  const content = await readAgent("git-manager");
  assert.match(content, /manual-testing\.md/);
});

test("final-reviewer valida secções por tarefa no guia manual (M007)", async () => {
  const content = await readAgent("final-reviewer");
  assert.match(content, /Guia de teste manual/);
  assert.match(content, /tasks_done/);
  assert.match(content, /Onde entrar/);
  assert.match(content, /bloqueantes/);
});

test("state-manager nunca apaga o manual-testing.md (M007)", async () => {
  const content = await readAgent("state-manager");
  assert.match(content, /manual-testing\.md/);
  assert.match(content, /Nunca apagues/);
});

test("orquestrador aponta o guia manual no reporte final (M007)", async () => {
  const content = await readAgent("loop-development");
  assert.match(content, /Instruções de teste manual/);
  assert.match(content, /manual-testing\.md/);
});

test("orquestrador define os dois modos de execução com tabela explícita", async () => {
  const content = await readAgent("loop-development");

  assert.match(content, /Modos de execução/);
  assert.match(content, /`complete`/);
  assert.match(content, /`simple`/);
  assert.match(content, /congelado à criação do plano/i);
  assert.match(content, /Planos sem o campo `mode` são tratados como `complete`/);
  assert.match(content, /default_mode/);
  assert.match(content, /nunca mudes o modo .* por iniciativa própria|nunca mudes o `mode` de um plano em curso/i);
  // Modo simple: por tarefa só implementer + state-manager
  assert.match(content, /13\.3 e 13\.12/);
  assert.match(content, /único gate de qualidade/);
  assert.match(content, /commitar todo o plano agora verificado/);
  // Grill-Me completo em ambos os modos, incluindo needs_research
  assert.match(content, /Corre por inteiro em ambos os modos/);
  assert.match(content, /\(isto vale também no modo `simple`\)/);
});

test("comando loop-development-simples existe e fixa o modo simple", async () => {
  const content = await readFile(join(PKG_ROOT, "opencode", "commands", "loop-development-simples.md"), "utf8");
  assert.match(content, /modo `simple`/);
  assert.match(content, /mode: "simple"/);
  assert.match(content, /agent: loop-development/);
});

test("continue respeita o modo gravado no plano", async () => {
  const content = await readFile(join(PKG_ROOT, "opencode", "commands", "loop-development-continue.md"), "utf8");
  assert.match(content, /`mode` gravado no plano retomado/);
  assert.match(content, /não mudes de modo na retoma/);
});

test("intake grava o modo do plano à criação e default_mode no esqueleto do projeto", async () => {
  const content = await readAgent("intake");
  assert.match(content, /"default_mode": "complete"/);
  assert.match(content, /\*\*Modo do plano \(`mode`\):\*\*/);
  assert.match(content, /O modo é imutável depois disto/i);
});

test("state-manager trata o modo como imutável e omite métricas no simple", async () => {
  const content = await readAgent("state-manager");
  assert.match(content, /`mode` — o modo de execução do plano/);
  assert.match(content, /imutável/i);
  assert.match(content, /No modo `simple`, omite este passo/);
});
