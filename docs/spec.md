# Loop Development

## Objetivo
Criar um agente orquestrador capaz de conduzir todo o ciclo de desenvolvimento de software de forma autónoma, recorrendo a subagents especializados, memória persistente, validação contínua e execução iterativa até à conclusão do projeto — um plano por funcionalidade.

## Arquitetura

- Loop Development (Primary)
  - Intake
  - Grill-Me
  - Researcher
  - Planner
  - Planner Writer
  - Architecture Reviewer
  - Task Generator
  - Dependency Auditor
  - Context Loader
  - Implementer
  - Refactorer
  - Test Writer
  - Verifier
  - Security Auditor
  - Performance Auditor
  - Documentation Writer
  - Git Manager (opcional)
  - State Manager
  - Compacter
  - Final Reviewer

## Fluxo

1. **Receção do pedido.** Intake garante que `.loop-development/` existe, cria a pasta do plano da funcionalidade (`plans/<timestamp>-<slug>/`), regista o pedido bruto no implementation-log e define o `active_plan`. Se estiver em formato antigo (flat), corre `npx loop-development migrate`.
2. Grill-Me conduz uma entrevista iterativa, fazendo **uma pergunta de cada vez**, reavaliando cada resposta e repetindo até não existirem ambiguidades. Decisões delegadas acionam pesquisa direcionada, apresentação de opções e escolha explícita.
3. Researcher consulta documentação oficial. Se a pesquisa contradisser uma decisão confirmada, o fluxo regressa ao Grill-Me.
4. Planner cria o plano.
5. Architecture Reviewer valida a arquitetura.
6. Planner Writer documenta o plano (`plans/<id>/spec.md` + `architecture.md` de projeto).
7. Compacter resume a sessão.
8. **PARAGEM OBRIGATÓRIA — aprovação do plano.** Esta aprovação inclui a decomposição normal em tarefas.
9. Task Generator divide o trabalho em tarefas.
10. Planner Writer documenta cada tarefa (`plans/<id>/tasks/*.md`).
11. Compacter atualiza o contexto.
12. A lista de tarefas é apresentada apenas informativamente e fica automaticamente aprovada pela aprovação do plano. O State Manager regista `tasks_approved_at` e `tasks_approval_source: "plan-approval"`. Divergências regressam ao Grill-Me/Planner e exigem nova aprovação do plano.
13. Para cada tarefa (na ordem):
    - Carrega o contexto (AGENTS.md, README, architecture.md, spec e state do plano ativo, tarefa, histórico, ficheiros relevantes).
    - Audita versões e compatibilidade das dependências.
    - Implementa.
    - Refatora.
    - Gera/atualiza testes.
    - Verifica: testes, typecheck, lint, prettier.
    - Auditoria de segurança.
    - Auditoria de performance.
    - Corrige até todas as verificações passarem.
    - Atualiza documentação (README, changelog, ADRs).
    - Commita com scope do slug do plano.
    - Atualiza estado persistente.
    - Compacta a sessão.
14. Repete até não existirem tarefas pendentes.
15. Final Reviewer executa revisão global.
16. Plano concluído: State Manager marca o plano `done` e limpa o `active_plan`.

O comando `/loop-development-continue [<id>]` retoma o plano ativo (ou o id indicado, trocando o `active_plan` via State Manager) na fase onde ficou, sem repetir fases já concluídas nem re-pedir aprovações já concedidas.

## Estado persistente

Dois níveis, em `.loop-development/`:

**Nível de projeto** (partilhado por todas as funcionalidades):
- `state.json` — fino: `version`, `active_plan`, registo `plans[]`, configuração (`min_coverage`).
- `architecture.md`
- `project-summary.md`
- `changelog.md`
- `risks.md`

**Nível de plano** — `plans/<YYYYMMDD.HHMM-<slug>>/`, uma pasta por funcionalidade:
- `state.json` — fase, `current_task`, `tasks_done`/`tasks_pending`.
- `spec.md` — especificação/plano macro aprovado.
- `decisions.md` — ADRs da funcionalidade.
- `clarifications.md` — histórico persistente do Grill-Me, pesquisas direcionadas e decisões confirmadas.
- `implementation-log/` — shards mensais (`YYYY-MM.md`) + `index.md`.
- `tasks/` — uma tarefa por ficheiro (`001-<slug>.md`).
- `summaries/` — resumos de sessão (Compacter).
- `metrics/` — métricas por tarefa.

O formato antigo (flat: `roadmap.md`, `tickets/`, etc.) é convertido por `npx loop-development migrate` para `plans/<timestamp>-projeto-inicial/`.

## Títulos de sessão

O opencode deixa as sessões com "Nova sessão" quando o titling nativo falha (sem `small_model`). O Loop Development inclui um plugin que renomeia as sessões do agente `loop-development` com um nome legível do plano ativo.

**Arquitetura** (padrão telegram-core):
- `opencode/plugins/session-title.ts` — plugin fino: carrega config, liga hooks.
- `opencode/plugins/core/session-title-core.js` — lógica pura testável: `computeTitle`, `decideAction`, estado, config.

**Comportamento**:
- Nome legível do plano: remove o prefixo de timestamp (`YYYYMMDD.HHMM-`) e converte kebab/snake em Title Case (`20260808.2246-login-google` → `Login Google`). Decidido a favor da legibilidade (o id completo fica disponível via estado).
- Gatilhos híbridos `chat.message` + `session.idle`, idempotente — só chama `session.update` se o título desejado diferir do atual.
- Âmbito restrito a `agent === "loop-development"` (configurável).
- Renomeações manuais são respeitadas: compara o título atual com o último definido pelo plugin; a troca de plano a meio da sessão atualiza o título.
- Primeira vez sobrescreve; sem plano ativo deixa o título como está.

**Config** (`~/.config/opencode/session-title.jsonc`, tudo opcional): `enabled` (true), `agents` (`["loop-development"]`), `prefix` (""), `suffix` (""), `mode` (`first`|`always`|`never`), `debug` (false).

**Estado** (`.loop-development/session-titles.json`, criado lazy): `{ version: 1, titles: { [sessionID]: { title, plan, updatedAt } } }`. É por-máquina e não é versionado — o `installProject` adiciona a entrada ao `.gitignore` do projeto.

## Context Loader

Antes de qualquer execução deve carregar automaticamente:
- AGENTS.md
- README.md
- `state.json` de projeto (para descobrir o `active_plan` e configuração)
- `architecture.md` e `risks.md` de projeto
- `spec.md`, `state.json` e `decisions.md` do plano ativo
- `implementation-log/` (index + shards relevantes ao histórico da tarefa)
- tarefa atual (`plans/<id>/tasks/<task-id>.md`)
- ficheiros afetados

## Critérios para concluir uma tarefa

Obrigatoriamente:
- Implementação completa.
- Testes aprovados.
- Cobertura mínima (configurável, default 80).
- Typecheck sem erros.
- Lint sem erros.
- Prettier aplicado.
- Auditoria de segurança aprovada.
- Auditoria de performance aprovada.
- Documentação atualizada.
- CHANGELOG atualizado (quando aplicável).
- Estado persistido.
- Sessão compactada.
- Commit criado.

## Responsabilidades dos subagents

### Researcher
- Documentação oficial
- Breaking changes
- Exemplos oficiais
- APIs recomendadas

### Architecture Reviewer
- SOLID
- Clean Architecture
- DDD
- Modularização
- Complexidade
- Dependências circulares

### Dependency Auditor
- Compatibilidade
- Peer dependencies
- Versões recomendadas

### Implementer
- Implementação da tarefa

### Refactorer
- Código morto
- Duplicação
- Complexidade
- Legibilidade

### Test Writer
- Configurar testes se inexistentes
- Criar testes da tarefa

### Verifier
- Tests
- Typecheck
- Lint
- Prettier

### Security Auditor
- SQL Injection
- XSS
- CSRF
- SSRF
- Secrets
- Auth
- Validação
- Audit de dependências

### Performance Auditor
- N+1
- Bundle
- Cache
- Lazy loading
- Índices
- Renderizações

### Documentation Writer
- README
- CHANGELOG
- API Docs
- ADR (plans/<id>/decisions.md)
- Spec do plano

### State Manager
- Atualiza progresso (projeto + plano ativo)
- Guarda estado
- Mantém o implementation-log

### Compacter
- Resume contexto para reduzir consumo de tokens

### Final Reviewer
- Revisão final completa
- Arquitetura
- Segurança
- Performance
- Testes
- Documentação
- Código morto
- Dependências órfãs

## CLI

- `npx loop-development init [--project]` — instalação global e/ou preparação do projeto.
- `npx loop-development update` — re-sincronização idempotente.
- `npx loop-development uninstall` — remoção limpa.
- `npx loop-development status` — estado da instalação + planos/tarefas.
- `npx loop-development migrate [<dir>]` — converte formato antigo para a estrutura por planos.
- `npx loop-development set-model <tier> <modelo>` — troca o modelo de uma camada.

## Filosofia

- Planeamento antes da implementação.
- Um plano por funcionalidade; um plano ativo de cada vez.
- Uma tarefa de cada vez.
- Estado persistente em dois níveis (projeto + plano).
- Evidências objetivas para concluir tarefas.
- Contexto mínimo carregado automaticamente.
- Correção iterativa até todas as verificações passarem.
- Loop contínuo até 100% do plano concluído.
