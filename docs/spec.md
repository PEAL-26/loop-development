# Loop Development

## Objetivo
Criar um agente orquestrador capaz de conduzir todo o ciclo de desenvolvimento de software de forma autónoma, recorrendo a subagents especializados, memória persistente, validação contínua e execução iterativa até à conclusão do projeto — um plano por funcionalidade.

## Requisito de plataforma

O pacote exige **OpenCode ≥ v2.0**. Depende de APIs que só existem no V2: permissões como
lista ordenada de regras, plugins com **default export** `{ id, setup }`, `ctx.storage`,
`ctx.location.directory` e o hook `ctx.session.hook("context")`. No V1 os plugins nem sequer
carregavam (o loader V1 aceitava named exports). `loop-development doctor` valida a versão
instalada e sai com código != 0 se ainda for V1.

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
- **Grants**: regras `{ action: "external_directory", resource: "<caminho>", effect: "allow" }` no array `permissions` de topo do `opencode.json` do projeto, com os padrões `<caminho>` e `<caminho>/**` (mecanismo nativo do opencode; dentro do projeto os defaults do workspace continuam a valer e `.env` continua protegido).
- **Merge aditivo por identidade de regra** (`action`+`resource`): `writeExternalDirectory`/`updateProjectConfig` só acrescentam regras em falta; uma colisão com `effect` diferente é reportada como conflito e a regra do utilizador fica intacta. `remove`/`clear` só apagam padrões gerados pelo Loop Development.
- **Caminhos**: normalizados (absolutos, forward slashes, `~` expandido); `add` valida que a pasta existe.
- **CLI**: `allow add|remove|list|clear` (com `--dry-run`/`--yes`).
- **Módulo**: `src/access.js` (lista canónica, normalização, grants, extensão defensiva `**/.loop-development/**` para agentes internos sem `"*": "allow"`).

### Ligação main/child (M003)

Quando um projeto vive dentro de outro, o Loop Development liga-os automaticamente para o child poder ler o contexto mínimo do main:

- **Detecção** (`src/link.js`): `findParentProject` sobe até 5 ancestrais e escolhe o mais próximo com `.loop-development/state.json` válido; `findChildProjects` desce a profundidade 1 (ignora `node_modules`, `.git` e pastas ocultas).
- **Persistência**: `state.json` do child ganha `parent: { path, name, linkedAt }`; o do main ganha `children: [{ path, name, linkedAt }]`. Cadeias são suportadas (um child pode ser main de outro).
- **Grants**: o child recebe regras `action: "external_directory"` para a raiz inteira do main (leitura) no array `permissions` de topo do seu `opencode.json`.
- **Contexto mínimo**: o Context Loader lê (só leitura) `architecture.md`, `state.json` e `project-summary.md` do main ao carregar contexto.
- **Gatilhos**: `installProject` (automático, desativável com `--no-link`), subcomando `link` (reconcilia ligações stale), e Intake corre `npx loop-development link` em cada novo plano.
- **Unlink**: `unlink <caminho>` remove a referência e os grants (consoante o papel: parent ou child).
- **Status**: mostra `parent`/`children[]` e a contagem de pastas permitidas.

### Proteção de segredos e variáveis de ambiente (M004)

Os agentes nunca documentam **valores reais** de variáveis de ambiente — apenas o nome e onde está configurada; `.env.example` usa placeholders.

- **Scanner interno** (`src/secrets.js`, zero dependências): padrões de alta/baixa confiança (tokens com prefixo, chaves privadas, pares `NOME_VAR=<valor tipo chave>`), com catálogo adicional por projeto em `.loop-development/secret-patterns.jsonc`.
- **CLI**: `npx loop-development secrets check [<dir>] [--history]` audita ficheiros versionados e, com `--history`, o histórico git (read-only; exit 0 limpo, 1 com achados de alta confiança). `npx loop-development secrets purge` reescreve o histórico com `git filter-repo` (ou instruções `filter-branch`), sempre com confirmação — e lembra que o segredo deve ser **rotacionado**.
- **Enforcement**: Security Auditor bloqueia tarefas com achados de alta confiança; Final Reviewer bloqueia o plano com achados no repositório todo/histórico.
- **`.gitignore`**: o `installProject` garante `.env`, `.env.*` e `!*.env.example` (aditivo); `secrets check` valida que `.env` não está versionado. A antiga entrada `.loop-development/session-titles.json` deixou de ser escrita — o estado do plugin vive em `ctx.storage`.

## Títulos de sessão

O opencode deixa as sessões com "Nova sessão" quando o titling nativo falha (sem `small_model`). O Loop Development inclui um plugin que renomeia as sessões do agente `loop-development` com um nome legível do plano ativo.

**Arquitetura** (padrão telegram-core):
- `opencode/plugins/session-title.ts` — plugin fino (default export `{ id, setup }`): carrega config, liga hooks, mantém o estado.
- `opencode/plugins/core/session-title-core.js` — lógica pura testável: `computeTitle`, `decideAction`, estado, config.
- `opencode/plugins/core/events.js` — normalização dos eventos do stream.

**Comportamento**:
- Nome legível do plano: remove o prefixo de timestamp (`YYYYMMDD.HHMM-`) e converte kebab/snake em Title Case (`20260808.2246-login-google` → `Login Google`). Decidido a favor da legibilidade (o id completo fica disponível via estado).
- Gatilhos: `ctx.session.hook("context")` captura o agente activo por sessão (o hook `chat.message` do V1 não existe em V2) e o evento `session.idle` dispara o rename. Idempotente — só chama `ctx.session.update` se o título desejado diferir do atual.
- Âmbito restrito a `agent === "loop-development"` (configurável).
- Renomeações manuais são respeitadas: compara o título atual com o último definido pelo plugin; a troca de plano a meio da sessão atualiza o título.
- Primeira vez sobrescreve; sem plano ativo deixa o título como está.

**Config** (`~/.config/opencode/session-title.jsonc`, tudo opcional): `enabled` (true), `agents` (`["loop-development"]`), `prefix` (""), `suffix` (""), `mode` (`first`|`always`|`never`), `debug` (false).

**Estado**: vive em `ctx.storage` do plugin, sob a chave `titles`, com a forma `{ version: 1, titles: { [sessionID]: { title, plan, updatedAt } } }`. É durável e scoped pelo id do plugin, por isso **não** existe `.loop-development/session-titles.json` no projeto e o `installProject` **não** escreve essa entrada no `.gitignore`.

## Permissões e config no OpenCode V2

**Forma do config.** O V2 trocou os mapas V1 (`agent.<id>.permission.<acção>` com um objeto padrão→efeito) por **listas ordenadas de regras** `{ action, resource, effect }`:

- `permissions` — array de topo no config global (guardas de shell);
- `agents.<id>.permissions` — array por agente (grants de projeto, que são legitimamente config-level);
- `opencode/opencode.json` do pacote tem **só** o array `permissions` de topo: 1 regra catch-all `{ shell, "*", allow }` + 35 regras destrutivas em `ask`. Os blocos por-agente foram **removidos de propósito**.

**Acções renomeadas** (`ACTION_RENAMES` em `src/constants.js`): `bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`.

**Fonte única das permissões internas.** O frontmatter `permissions:` dos 21 `.md` é a **única** fonte das permissões internas dos nossos agentes (quem o orquestrador pode chamar via `subagent`, `read`/`glob`/`edit` sobre `.loop-development/**`, `edit`/`webfetch`/`skill`/`question` conforme o papel). No V1 a duplicação entre `.md` e config era inofensiva (dois mapas mesclavam por chave); no V2 as duas listas aplicam-se em conjunto e, se divergissem, o vencedor dependia da ordem de carga. O `opencode.json` global não volta a duplicar.

**Ordem.** Vale a **última regra que casa**, e as regras anexam. Não existe "as regras do agente prevalecem sobre o global". Por isso a inserção é sensível à ordem (`insertRule`): uma regra broad (`resource: "*"`) entra depois da última broad da mesma acção e antes de qualquer específica; uma específica entra ao fim. Sem isto, o grant broad `"*": "allow"` do projeto (que tem de preceder as excepções `*.env` em `ask`) sombrearia excepções já existentes.

**Merge estritamente aditivo** (`mergeManaged`): a identidade de uma regra é `action`+`resource` (o `effect` não entra). Se a regra já existir com o mesmo `effect`, nada muda; com `effect` diferente, é um **conflito reportado** — a do utilizador é mantida. Nunca se remove nem reordena uma regra do utilizador: sobrescrever exigiria removê-la e reinseri-la, o que alteraria a ordem relativa face às restantes.

**Grants de projeto.** `installProject` escreve em `agents.<id>.permissions` de todos os agentes: `read`/`glob` em `"*": "allow"` (mais `edit` para implementer, test-writer, refactorer e documentation-writer), com as excepções `*.env` e `*.env.*` em `ask` e `*.env.example` em `allow` logo a seguir.

**Frontmatter dos agentes.** `permission:`→`permissions:` (array), `task`→`subagent`, `write`/`patch`→`edit`, bloco `tools:` removido do `loop-development.md` (obsoleto — a regra `{ edit, "*", deny }` já cobre), `temperature:`→`request.body.temperature`.

> **Ressalva da temperatura.** `request.body.temperature` é a forma correta para o futuro, mas o runner de sessões do V2.0.11 **preserva estes valores sem os enviar** nos pedidos ao modelo. As temperaturas dos 21 agentes (14 a `0.1`, 5 a `0.2`, 2 a `0.3`) estão no ficheiro mas **não são aplicadas hoje**. Nada se perdeu com a migração — no V1 também não eram aplicadas — mas a documentação não deve prometer o que o runtime não faz.

**Manifesto v2.** `manifestVersion: 2`; `configAdded` passa a `[{ scope, agent?, action, resource, effect }]` com identidade de regra, e `files` a `[{ path, sha256, shippedIn }]`. O `uninstall` remove regras **por identidade**, não por caminho de chave.

**Installer version-aware** (`resolveFileAction`): hash instalado == hash embarcado anteriormente → *staleness* → refresca (com backup); hash instalado diferente → **editado pelo utilizador** → não sobrescreve, avisa, e o `doctor` reporta-o; ficheiro inexistente → copia; `--force` → refresca sempre, com backup.

## Plugins

Os dois plugins (`session-title`, `telegram`) seguem o formato V2:

- **default export** `{ id, setup }` — o loader V2 rejeita named exports (o sintoma no log é `failed to load plugin` … `Missing key at ["default"]`, que era exatamente o que impedia os plugins V1 de carregarem);
- `setup(ctx)` devolve a função de cleanup, que aborta o `AbortController` de `ctx.event.subscribe({ signal })`;
- todo o estado é **closure do `setup`** — o V2 instancia plugins por localização, logo estado a nível de módulo seria partilhado entre instâncias (um bug silencioso);
- eventos filtrados por `ctx.location.directory`, porque o stream é global;
- **sem dependências de runtime**: o único import de `@opencode/plugin` é `import type`, apagado em runtime — a pasta de config do OpenCode nunca precisa de `node_modules`.

**Telegram.** Continua server plugin, mas **só permissões**. As permissões V2 são session-scoped: a notificação vem de `permission.v2.asked` (com fallback para o `permission.asked` legado), a resposta usa `ctx.permission.reply({ sessionID, requestID, decision })` — o campo é `decision`, **não** `reply` — e a reconciliação no arranque itera as sessões conhecidas em `telegram-state.json` (`knownSessions`), já que `ctx.session` não expõe `list()`. As **perguntas** (`question`) não são respondíveis: o V2 não expõe um domínio question/form a plugins de servidor (só a API de CLI/TUI tem `session.form.reply`), logo chegam como **notificação sem botões**, com instrução de abrir o TUI. O estado continua em `telegram-state.json`.

## Diagnóstico: `loop-development doctor`

`src/doctor.js`, comando `doctor [--fix] [--dir <dir>] [--config-dir <dir>]`. Seis verificações:

1. **Versão do OpenCode** — `opencode --version`; falha se ainda for V1.
2. **Manifesto** — versão instalada vs. pacote, `manifestVersion`, ficheiros embarcados em falta e hashes stale (pela mesma política do installer: edição do utilizador não é erro).
3. **Forma do config** — detecta chaves V1 (`agent`, `permission` como objeto) que o V2 ignora.
4. **Frontmatter dos agentes** — detecta `permission:`, `temperature:` e `tools:` nos `.md` instalados.
5. **Plugins** — verificação estática de `export default` **e** leitura de `~/.local/share/opencode/log/opencode.log` à procura de `failed to load plugin` recente que mencione os nossos caminhos. O log é a fonte de verdade: um `-` na coluna VERSION do `plugin list` não é sinal de falha.
6. **Dependências** (`src/deps.js`, `VERIFY_DEPS = ["@opencode/plugin", "typescript", "@types/node"]`) — só num checkout de desenvolvimento; fora disso reporta que não há nada a verificar, em vez de um falso "tudo OK".

Sai com código != 0 se algo estiver errado. `--fix` repara o automático (dependências em falta, com o package manager detetado, e a migração do config); o resto vem com a instrução de como resolver.

## Migração V1 → V2

`migrateV1ToV2` (em `mergeConfigFile`, portanto tanto no `init`/`update` global como no `init --project`) converte `agent`→`agents`, mapas `permission`→arrays `permissions` com as renomeações de acção, `permission.bash`→regras `action: "shell"`, `permission.external_directory`→regras `action: "external_directory"`, `prompt`→`system` e `disable`→`disabled`. É **aditiva e idempotente**, corre mesmo em configs de projeto, faz backup do ficheiro e devolve um relatório do que converteu; o que não reconhece fica preservado para o `doctor` o apanhar. O que a migração **não** faz: sobrescrever um `.md` editado à mão, remover ou reordenar regras do utilizador.

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
- `npx loop-development doctor [--fix] [--dir <dir>]` — diagnostica a instalação contra o OpenCode V2 (6 verificações; sai com código != 0 se algo estiver errado; `--fix` repara o automático).
- `npx loop-development models` — audita os modelos dos agentes instalados contra o catálogo models.dev.
- `npx loop-development set-mode <simple|complete>` — define o modo default do projeto (`default_mode`), afeta apenas planos novos.
- `npx loop-development migrate [<dir>]` — converte formato antigo para a estrutura por planos.
- `npx loop-development architecture check [<dir>]` — audita `architecture.md` contra o contrato de conteúdo (read-only; exit code 0 limpo, 1 com violações).
- `npx loop-development secrets check [<dir>] [--history]` — audita valores sensíveis de variáveis de ambiente em ficheiros versionados e no histórico git (read-only; exit code 0 limpo, 1 com achados de alta confiança).
- `npx loop-development secrets purge [<dir>] [--tool filter-repo|filter-branch]` — reescreve o histórico para remover ficheiros com segredos (com confirmação; `--dry-run` lista sem alterar).
- `npx loop-development allow add|remove|list|clear <caminho>` — gestão de pastas externas autorizadas (regras `external_directory`).
- `npx loop-development link [<dir>]` — liga o projeto ao main, regista children e reconcilia ligações stale.
- `npx loop-development unlink <caminho>` — remove a ligação main/child (estado + grants).
- `npx loop-development set-model <tier> <modelo>` — troca o modelo de uma camada (sintaxe compatível).
- `npx loop-development set-model --<tier> <modelo> ...` — troca os modelos dos tiers indicados.
- `npx loop-development set-model --all <modelo>` — troca o modelo de todos os tiers.
- `npx loop-development set-model --defaults` — restaura os modelos default de todos os tiers.
- `npx loop-development telegram setup|status|reset` — configuração do bot do Telegram para aprovações remotas de **permissões** (as perguntas são só notificação, sem botões).
- `npx loop-development --list-presets` — lista os presets de stack disponíveis.

## Filosofia

- Planeamento antes da implementação.
- Um plano por funcionalidade; um plano ativo de cada vez.
- Uma tarefa de cada vez.
- Estado persistente em dois níveis (projeto + plano).
- Evidências objetivas para concluir tarefas.
- Contexto mínimo carregado automaticamente.
- Correção iterativa até todas as verificações passarem.
- Loop contínuo até 100% do plano concluído.
