# Loop Development

## Objetivo
Criar um agente orquestrador capaz de conduzir todo o ciclo de desenvolvimento de software de forma autónoma, recorrendo a subagents especializados, memória persistente, validação contínua e execução iterativa até à conclusão do projeto.

## Arquitetura

- Loop Development (Primary)
  - Intake
  - Grill-Me
  - Researcher
  - Planner
  - Planner Writer
  - Architecture Reviewer
  - Ticket Generator
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

1. Recebe o pedido.
2. Grill-Me identifica ambiguidades.
3. Researcher consulta documentação oficial.
4. Planner cria o plano.
5. Architecture Reviewer valida a arquitetura.
6. Planner Writer documenta o plano.
7. Compacter resume a sessão.
8. Ticket Generator divide o trabalho em tickets.
9. Planner Writer documenta cada ticket.
10. Compacter atualiza o contexto.
11. Aguarda aprovação do utilizador.
12. Para cada ticket:
   - Carrega o contexto (AGENTS.md, README, roadmap, state, ticket, ficheiros relevantes).
   - Pesquisa documentação oficial das dependências.
   - Audita versões e compatibilidade.
   - Implementa.
   - Refatora.
   - Gera/atualiza testes.
   - Executa testes.
   - Executa typecheck.
   - Executa lint.
   - Executa prettier.
   - Executa auditoria de segurança.
   - Executa auditoria de performance.
   - Corrige até todas as verificações passarem.
   - Atualiza documentação.
   - Atualiza estado persistente.
   - Compacta a sessão.
13. Repete até não existirem tickets.
14. Final Reviewer executa revisão global.
15. Projeto concluído.

## Estado persistente

.loop-development/
- state.json
- roadmap.md
- architecture.md
- project-summary.md
- implementation-log.md
- risks.md
- decisions.md
- changelog.md
- tickets/
- summaries/
- metrics/

## Context Loader

Antes de qualquer execução deve carregar automaticamente:
- AGENTS.md
- opencode.json
- README.md
- roadmap.md
- state.json
- ticket atual
- histórico do ticket
- ficheiros afetados
- documentação das dependências relevantes

## Critérios para concluir um ticket

Obrigatoriamente:
- Implementação completa.
- Testes aprovados.
- Cobertura mínima (configurável).
- Typecheck sem erros.
- Lint sem erros.
- Prettier aplicado.
- Auditoria de segurança aprovada.
- Auditoria de performance aprovada.
- Documentação atualizada.
- CHANGELOG atualizado (quando aplicável).
- Estado persistido.
- Sessão compactada.

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
- Implementação do ticket

### Refactorer
- Código morto
- Duplicação
- Complexidade
- Legibilidade

### Test Writer
- Configurar testes se inexistentes
- Criar testes do ticket

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
- ADR
- Roadmap

### State Manager
- Atualiza progresso
- Guarda estado

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

## Filosofia

- Planeamento antes da implementação.
- Um ticket de cada vez.
- Estado persistente.
- Evidências objetivas para concluir tarefas.
- Contexto mínimo carregado automaticamente.
- Correção iterativa até todas as verificações passarem.
- Loop contínuo até 100% do projeto concluído.
