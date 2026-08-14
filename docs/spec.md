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
6. Planner Writer documenta o plano (`plans/<id>/spec.md` + `architecture.md` de projeto). O `architecture.md` segue um **contrato de conteúdo**: é a base estrutural geral do projeto (stack, regras/convenções, estrutura de pastas, decisões transversais), nunca um log da implementação — sem fase do projeto, funções específicas de features, justificações MVP, migrações/scripts SQL de tarefas ou listas de tarefas. O Planner Writer faz poda incondicional ao atualizá-lo.
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
    - Verifica (matriz por tarefa): testes afetados + typecheck, lint, prettier. Sem build e sem suite completa.
    - Auditoria de segurança.
    - Auditoria de performance.
    - Corrige até todas as verificações passarem.
    - Atualiza documentação (README, changelog, ADRs).
    - Commita com scope do slug do plano.
    - Atualiza estado persistente.
    - Compacta a sessão.
14. Repete até não existirem tarefas pendentes.
15. **Verificação final do plano**: o Verifier corre em modo plano (build + suite completa + cobertura mínima + typecheck + lint + prettier), com loop de correção (Implementer/Refactorer) até passar; as correções são commitadas como fix commits com o scope do plano (sem amend/rebase).
16. Final Reviewer executa revisão global (incluindo validar o contrato de conteúdo de `architecture.md` via `loop-development architecture check` e o `secrets check`).
17. Plano concluído: State Manager marca o plano `done` e limpa o `active_plan`.

O comando `/loop-development-continue [<id>]` retoma o plano ativo (ou o id indicado, trocando o `active_plan` via State Manager) na fase onde ficou, sem repetir fases já concluídas nem re-pedir aprovações já concedidas.

## Estado persistente

Dois níveis, em `.loop-development/`:

**Nível de projeto** (partilhado por todas as funcionalidades):
- `state.json` — fino: `version`, `active_plan`, registo `plans[]`, configuração (`min_coverage`, `verification`), e as ligações main/child (`parent` no child, `children[]` no main).
- `allowed-folders.json` — lista canónica de pastas externas autorizadas (`{ version: 1, folders: [{ path, addedAt, source }] }`).
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
- `manual-testing.md` — guia de teste manual acumulativo, atualizado pelo Test Writer a cada tarefa concluída (M007).

O formato antigo (flat: `roadmap.md`, `tickets/`, etc.) é convertido por `npx loop-development migrate` para `plans/<timestamp>-projeto-inicial/`.

## Acesso a pastas externas e ligação main/child

### Pastas externas (M002)

O opencode bloqueia o acesso fora da raiz do projeto. O Loop Development oferece uma lista canónica de pastas externas autorizadas:

- **Lista**: `.loop-development/allowed-folders.json` (`{ version: 1, folders: [{ path, addedAt, source }] }`).
- **Grants**: `permission.external_directory` no `opencode.json` do projeto, com os padrões `<caminho>` e `<caminho>/**` em `allow` (mecanismo nativo do opencode; dentro do projeto os defaults do workspace continuam a valer e `.env` continua protegido).
- **Merge aditivo**: `writeExternalDirectory`/`updateProjectConfig` só preenchem chaves em falta; regras manuais do utilizador nunca são sobrepostas. `remove`/`clear` só apagam padrões gerados pelo Loop Development.
- **Caminhos**: normalizados (absolutos, forward slashes, `~` expandido); `add` valida que a pasta existe.
- **CLI**: `allow add|remove|list|clear` (com `--dry-run`/`--yes`).
- **Módulo**: `src/access.js` (lista canónica, normalização, grants, extensão defensiva `**/.loop-development/**` para agentes internos sem `"*": "allow"`).

### Ligação main/child (M003)

Quando um projeto vive dentro de outro, o Loop Development liga-os automaticamente para o child poder ler o contexto mínimo do main:

- **Detecção** (`src/link.js`): `findParentProject` sobe até 5 ancestrais e escolhe o mais próximo com `.loop-development/state.json` válido; `findChildProjects` desce a profundidade 1 (ignora `node_modules`, `.git` e pastas ocultas).
- **Persistência**: `state.json` do child ganha `parent: { path, name, linkedAt }`; o do main ganha `children: [{ path, name, linkedAt }]`. Cadeias são suportadas (um child pode ser main de outro).
- **Grants**: o child recebe a raiz inteira do main via `external_directory` (leitura).
- **Contexto mínimo**: o Context Loader lê (só leitura) `architecture.md`, `state.json` e `project-summary.md` do main ao carregar contexto.
- **Gatilhos**: `installProject` (automático, desativável com `--no-link`), subcomando `link` (reconcilia ligações stale), e Intake corre `npx loop-development link` em cada novo plano.
- **Unlink**: `unlink <caminho>` remove a referência e os grants (consoante o papel: parent ou child).
- **Status**: mostra `parent`/`children[]` e a contagem de pastas permitidas.

### Proteção de segredos e variáveis de ambiente (M004)

Os agentes nunca documentam **valores reais** de variáveis de ambiente — apenas o nome e onde está configurada; `.env.example` usa placeholders.

- **Scanner interno** (`src/secrets.js`, zero dependências): padrões de alta/baixa confiança (tokens com prefixo, chaves privadas, pares `NOME_VAR=<valor tipo chave>`), com catálogo adicional por projeto em `.loop-development/secret-patterns.jsonc`.
- **CLI**: `npx loop-development secrets check [<dir>] [--history]` audita ficheiros versionados e, com `--history`, o histórico git (read-only; exit 0 limpo, 1 com achados de alta confiança). `npx loop-development secrets purge` reescreve o histórico com `git filter-repo` (ou instruções `filter-branch`), sempre com confirmação — e lembra que o segredo deve ser **rotacionado**.
- **Enforcement**: Security Auditor bloqueia tarefas com achados de alta confiança; Final Reviewer bloqueia o plano com achados no repositório todo/histórico.
- **`.gitignore`**: o `installProject` garante `.env`/`.env.*` ignorados (aditivo); `secrets check` valida que `.env` não está versionado.

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
- `summaries/index.md` + o resumo mais recente (como **contexto de retoma**: delta e próximo passo; nunca substituem o `state.json` nem os canónicos)
- tarefa atual (`plans/<id>/tasks/<task-id>.md`)
- ficheiros afetados
- contexto do main, se existir (`parent` em `state.json`): `architecture.md`, `state.json` e `project-summary.md` do main, **só leitura**

## Critérios para concluir uma tarefa

Obrigatoriamente:
- Implementação completa.
- Testes afetados aprovados (quando a stack permite testes direcionados; senão, adiados para a verificação final).
- Typecheck sem erros.
- Lint sem erros.
- Prettier aplicado.
- Auditoria de segurança aprovada.
- Auditoria de performance aprovada.
- Documentação atualizada.
- `manual-testing.md` atualizado com a secção de teste manual da tarefa.
- CHANGELOG atualizado (quando aplicável).
- Estado persistido.
- Sessão compactada.
- Commit criado.

A **verificação final do plano** (build + suite completa + cobertura mínima) é critério do plano, não de cada tarefa.

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
- Tests (afetados por tarefa; suite completa no modo plano)
- Typecheck
- Lint
- Prettier
- Build (só no modo plano, verificação final)

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
- Regra: nunca duplicar decisões — referencia `decisions.md`/`clarifications.md`

### State Manager
- Atualiza progresso (projeto + plano ativo)
- Guarda estado
- Mantém o implementation-log (evento + referências, sem repetir decisões/fases/verificação)
- Rotação de summaries de tarefas concluídas

### Compacter
- Resume contexto para reduzir consumo de tokens
- Resumo = delta desde o anterior, com referências aos canónicos (anti-redundância)
- Atualiza `summaries/index.md`

### Final Reviewer
- Revisão final completa
- Arquitetura
- Segurança
- Performance
- Testes
- Documentação
- Código morto
- Dependências órfãs
- Redundância em summaries/implementation-log (pendências acionáveis)

## CLI

- `npx loop-development init [--project]` — instalação global e/ou preparação do projeto.
- `npx loop-development update` — re-sincronização idempotente.
- `npx loop-development uninstall` — remoção limpa.
- `npx loop-development status` — estado da instalação + planos/tarefas.
- `npx loop-development migrate [<dir>]` — converte formato antigo para a estrutura por planos.
- `npx loop-development architecture check [<dir>]` — audita `architecture.md` contra o contrato de conteúdo (read-only; exit code 0 limpo, 1 com violações).
- `npx loop-development secrets check [<dir>] [--history]` — audita valores sensíveis de variáveis de ambiente em ficheiros versionados e no histórico git (read-only; exit code 0 limpo, 1 com achados de alta confiança).
- `npx loop-development secrets purge [<dir>] [--tool filter-repo|filter-branch]` — reescreve o histórico para remover ficheiros com segredos (com confirmação; `--dry-run` lista sem alterar).
- `npx loop-development allow add|remove|list|clear <caminho>` — gestão de pastas externas autorizadas (`external_directory`).
- `npx loop-development link [<dir>]` — liga o projeto ao main, regista children e reconcilia ligações stale.
- `npx loop-development unlink <caminho>` — remove a ligação main/child (estado + grants).
- `npx loop-development set-model <tier> <modelo>` — troca o modelo de uma camada (sintaxe compatível).
- `npx loop-development set-model --<tier> <modelo> ...` — troca os modelos dos tiers indicados.
- `npx loop-development set-model --all <modelo>` — troca o modelo de todos os tiers.
- `npx loop-development set-model --defaults` — restaura os modelos default de todos os tiers.

## Filosofia

- Planeamento antes da implementação.
- Um plano por funcionalidade; um plano ativo de cada vez.
- Uma tarefa de cada vez.
- Estado persistente em dois níveis (projeto + plano).
- Evidências objetivas para concluir tarefas.
- Contexto mínimo carregado automaticamente.
- Correção iterativa até todas as verificações passarem.
- Loop contínuo até 100% do plano concluído.
