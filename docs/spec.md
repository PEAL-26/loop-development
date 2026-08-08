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
2. Grill-Me identifica ambiguidades, fazendo **uma pergunta de cada vez** e adaptando as perguntas seguintes às respostas do utilizador.
3. Researcher consulta documentação oficial.
4. Planner cria o plano.
5. Architecture Reviewer valida a arquitetura.
6. Planner Writer documenta o plano (`plans/<id>/spec.md` + `architecture.md` de projeto).
7. Compacter resume a sessão.
8. **PARAGEM OBRIGATÓRIA — aprovação do plano.**
9. Task Generator divide o trabalho em tarefas.
10. Planner Writer documenta cada tarefa (`plans/<id>/tasks/*.md`).
11. Compacter atualiza o contexto.
12. **PARAGEM OBRIGATÓRIA — aprovação da lista de tarefas.**
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
- `implementation-log/` — shards mensais (`YYYY-MM.md`) + `index.md`.
- `tasks/` — uma tarefa por ficheiro (`001-<slug>.md`).
- `summaries/` — resumos de sessão (Compacter).
- `metrics/` — métricas por tarefa.

O formato antigo (flat: `roadmap.md`, `tickets/`, etc.) é convertido por `npx loop-development migrate` para `plans/<timestamp>-projeto-inicial/`.

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
