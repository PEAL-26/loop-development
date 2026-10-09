# Loop Development para OpenCode

Agente orquestrador global para o OpenCode que conduz todo o ciclo de desenvolvimento de software de forma autónoma, desde o pedido inicial até à conclusão do projeto, coordenando 20 subagents especializados e mantendo estado persistente em `.loop-development/` dentro de cada projeto.

## Requisitos

- Node.js ≥ 18
- [OpenCode](https://opencode.ai/) **≥ v2.0** instalado

> **V2 obrigatório.** O Loop Development usa a API de permissões por regras ordenadas
> (`permissions: [{ action, resource, effect }]`), `agents.<id>.permissions` e plugins com
> **default export** `{ id, setup }`. Nada disto existe no V1 — onde os plugins, por sinal,
> nunca carregavam. O comando `loop-development doctor` verifica a versão instalada e falha
> se ainda for V1.

## Instalação

### 1. Instalação global (agentes + comandos + scripts)

```bash
npx loop-development init
```

Instala em `~/.config/opencode/`:

- `agents/` — os 21 agentes (orquestrador + 20 subagents), com as permissões internas no **frontmatter** de cada `.md`;
- `commands/` — os comandos `/loop-development`, `/loop-development-continue` e `/loop-development-status`;
- `scripts/` — o `set-model.sh` (alternativa em bash ao subcomando `set-model`);
- `templates/` — o esqueleto de estado persistente para novos projetos;
- `plugins/` — os dois plugins (`session-title` e `telegram`), em formato V2 (default export);
- mescla no `opencode.json` (ou `opencode.jsonc`) existente **apenas as guardas de shell**: o array `permissions` de topo com `action: "shell"` — `"*": "allow"` mais os padrões destrutivos em `"ask"` (ver *Autonomia e permissões*), com backup em `opencode.json.bak-loop-development`. É o **único** bloco que o pacote escreve no teu config global, porque **as permissões internas dos nossos agentes vivem só no frontmatter dos `.md`** (ver *Autonomia e permissões*);
- o merge é **aditivo por identidade de regra** (`action` + `resource`). Numa regra tua com o mesmo par mas `effect` diferente, o Loop Development **não toca** — reporta um **conflito** e mantém a tua. Nunca remove nem reordena regras tuas;
- **remove entradas stale** de agentes que o Loop Development já não instala como ficheiros (`implementer`, `verifier`, `loop-triage` em versões antigas), regras `shell` por-agente que versões antigas adicionavam, e o artefacto inválido `agents.permission` — após backup, para não reativarem permissões antigas.

Repetir o comando é seguro (idempotente). **Ficheiros que tenhas editado à mão não são sobrescritos** — o installer só refresca o que consegue provar que é uma versão nossa mais antiga; para substituir mesmo o teu, usa `--force` (faz backup do que troca). O `update` é o comando que sincroniza o resto. Reinicia o OpenCode depois de instalar.

Diretórios de config suportados, por ordem de prioridade:

1. `--config-dir <dir>` (override explícito);
2. `OPENCODE_CONFIG_DIR`;
3. `XDG_CONFIG_HOME/opencode`;
4. `~/.config/opencode`.

### 2. Preparar um projeto para usar o Loop Development

Isto é por projeto, porque o estado é específico a cada um:

```bash
npx loop-development init --project
```

Cria no diretório atual (ou no caminho indicado: `init --project <dir>`):

- `.loop-development/` — esqueleto do estado persistente;
- `AGENTS.md` — gerado a partir dos presets de stack que escolheres (ou do template, se escolheres "manual");
- **grants de acesso ao projeto** — o `installProject` também grava, de forma **aditiva**, regras por agente em `agents.<id>.permissions` no `opencode.json` da raiz do projeto (criando-o se não existir, com backup `opencode.json.bak-loop-development` se existir). Todos os agentes do pacote recebem `read`/`glob` em `"*": "allow"` e os agentes que escrevem código/testes/docs (implementer, test-writer, refactorer, documentation-writer) recebem `edit` em `allow`. Isto evita o loop parar a pedir permissão em cada leitura/escrita dentro do projeto. O merge é **puramente aditivo**: só acrescenta regras que ainda não existam e, se uma regra tua casar com o mesmo `action`+`resource` mas outro `effect`, é reportada como **conflito** e fica intacta.
- **exceção `.env`:** depois do `"*": "allow"`, cada acção repete as regras `.env` dos defaults do opencode — `"*.env": "ask"` e `"*.env.*": "ask"` (ficheiros de segredos pedem aprovação, mesmo com o broad allow), e `"*.env.example": "allow"` (templates continuam legíveis/editáveis). Isto é necessário porque **as regras anexam e a última que casa ganha**: o grant broad `"*": "allow"` tem de preceder estas exceções, senão desligaria a proteção nativa de `.env`. Por isso a inserção de uma regra broad é sensível à ordem (entra depois da última broad da mesma acção e antes de qualquer específica). (Limitação conhecida do opencode: a permissão `glob` casa sobre o *padrão* pedido, não sobre os ficheiros que o padrão devolve — para proteger conteúdo de `.env` contra grep/glob, o guarda é o `read`.)
- **`.gitignore`:** garante `.env`, `.env.*` e `!*.env.example`. Já **não** escreve `.loop-development/session-titles.json` — em V2 o estado dos títulos de sessão vive em `ctx.storage` (ver *Títulos de sessão*).

O comando abre um **wizard interativo** (escolhe backend → frontend → gestor de pacotes). Para não-interativo (CI/scripts):

```bash
npx loop-development init --project --backend nestjs-prisma --frontend expo --pm pnpm
```

```bash
npx loop-development --list-presets   # lista os presets disponíveis
```

Presets incluídos (alinhados com convenções de mercado — fonte: docs oficiais de cada stack):

| Tipo | id | Stack |
|---|---|---|
| Backend | `nestjs-prisma` | NestJS 11 + Prisma 7 + PostgreSQL |
| Backend | `nestjs-supabase` | NestJS 11 + Supabase (RLS/Auth/Storage) |
| Backend | `express` | Node.js + Express 5 + TypeScript |
| Backend | `fastify` | Fastify 5 + TypeScript |
| Frontend | `expo` | Expo SDK 55 (React Native) + Expo Router |
| Frontend | `next` | Next.js 16 (App Router) + Tailwind |
| Frontend | `vite` | React + Vite + TypeScript |

O gestor de pacotes (`npm`/`pnpm`/`yarn`/`bun`) é **detetado** no projeto (lockfiles ou campo `packageManager`); se não houver sinais, o wizard pergunta. O `AGENTS.md` gerado preenche as 5 secções (Stack, Convenções, Comandos, Estrutura, O que nunca fazer) com comandos reais por gestor — revisa e ajusta se o teu projeto for diferente.

Depois **revisa o `AGENTS.md`** — é isto que dá ao Verifier e ao Test Writer comandos reais em vez de adivinhados. Também podes deixar o próprio Intake criar a pasta `.loop-development/` automaticamente na primeira invocação, se preferires não correr o `init --project`.

## Subcomandos do CLI

| Comando | Descrição |
|---|---|
| `loop-development init` | Instala agentes/comandos globalmente (idempotente). |
| `loop-development init --project [dir]` | Prepara um projeto (`.loop-development/` + `AGENTS.md`) — wizard de presets ou `--backend/--frontend/--pm`. |
| `loop-development update` | Re-sincroniza a partir do pacote. |
| `loop-development uninstall` | Remove apenas o que foi instalado pelo Loop Development (usa o manifesto). |
| `loop-development status` | Mostra o estado da instalação e do projeto atual. |
| `loop-development doctor [--fix] [--dir <dir>]` | Diagnostica a instalação contra o OpenCode V2 (6 verificações; sai com código != 0 se algo estiver errado). |
| `loop-development set-model <tier> <modelo>` | Troca o modelo de todos os agentes de uma camada (sintaxe compatível). |
| `loop-development set-model --<tier> <modelo> ...` | Troca os modelos dos tiers indicados. |
| `loop-development set-model --all <modelo>` | Troca o modelo de todos os agentes de todos os tiers. |
| `loop-development set-model --defaults` | Restaura os modelos default de todos os tiers. |
| `loop-development set-mode <simple\|complete>` | Define o modo de execução default do projeto (`default_mode` no `.loop-development/state.json`). Afeta apenas planos novos. |
| `loop-development models` | Audita os modelos dos agentes instalados contra o catálogo models.dev. |
| `loop-development migrate [<dir>]` | Converte um projeto do formato antigo (`.loop-development/` flat) para a estrutura por planos. |
| `loop-development architecture check [<dir>]` | Audita `.loop-development/architecture.md` contra o contrato de conteúdo (read-only; exit 0 limpo, 1 com violações). |
| `loop-development secrets check [<dir>] [--history]` | Audita valores sensíveis de variáveis de ambiente em ficheiros versionados e, com `--history`, no histórico git (read-only; exit 0 limpo, 1 com achados de alta confiança). |
| `loop-development secrets purge [<dir>] [--tool filter-repo\|filter-branch]` | Reescreve o histórico git para remover ficheiros com segredos (requer confirmação; `--dry-run` lista sem alterar). |
| `loop-development allow add <caminho>` | Autoriza uma pasta fora do projeto (grava regras `external_directory` no `opencode.json`). |
| `loop-development allow remove <caminho>` | Retira a autorização de uma pasta externa. |
| `loop-development allow list` | Lista as pastas externas autorizadas. |
| `loop-development allow clear` | Remove todas as autorizações externas. |
| `loop-development link [<dir>]` | Liga o projeto ao main (ancestral com `.loop-development/`), regista children e reconcilia ligações stale. |
| `loop-development unlink <caminho>` | Remove a ligação main/child (estado + grants de acesso). |
| `loop-development telegram setup` | Configura o bot do Telegram para aprovações remotas de permissões (as perguntas são só notificação). |
| `loop-development telegram status` | Mostra o estado da configuração do Telegram (token, chave de emparelhamento, chats autorizados). |
| `loop-development telegram reset` | Remove a configuração do Telegram. |
| `loop-development --list-presets` | Lista os presets de stack disponíveis. |
| `loop-development --version` / `--help` | Versão / ajuda. |

Opções comuns: `--yes` (não confirmar), `--force` (sobrescrever existentes), `--dry-run` (mostrar sem alterar), `--config-dir <dir>`. No `init --project`: `--backend <id>`, `--frontend <id>`, `--pm <npm|pnpm|yarn|bun>` (tornam o fluxo não-interativo) e `--no-link` (não correr a ligação automática main/child). No `doctor`: `--fix` (repara o que for automático) e `--dir <dir>` (diretório a usar como raiz).

## Como usar

**Opção A, comando direto (recomendado para arrancar um projeto novo):**

```
/loop-development Cria uma todo list web em React + Vite + Tailwind: adicionar, concluir, editar e remover tarefas, filtros (todas/ativas/concluídas), persistência em localStorage, tema claro/escuro e design limpo e responsivo.
```

**Opção A2, modo simple (poupa contexto/tokens):**

```
/loop-development-simples Cria uma todo list web em React + Vite + Tailwind: adicionar, concluir, editar e remover tarefas.
```

**Opção B, agente primário (Tab):**

No TUI/CLI do OpenCode, prime `Tab` para trocar de agente até chegares ao `loop-development`, e conversa normalmente, descreve o que queres construir.

> Cada invocação do `/loop-development` (ou do agente primário com um pedido novo) **cria um plano novo** — isto permite usar o Loop Development em projetos existentes, uma funcionalidade de cada vez, sem misturar especificações, tarefas ou histórico de funcionalidades diferentes. Todo o estado de uma funcionalidade vive em `.loop-development/plans/<timestamp>-<slug>/`; arquitetura, changelog, riscos e resumo do projeto ficam no nível partilhado do projeto.

**Retomar trabalho numa sessão nova:**

```
/loop-development-continue [id-ou-slug-do-plano]
```

Lê `.loop-development/state.json`, retoma o plano ativo (ou o plano indicado como argumento) e continua exatamente de onde ficou, sem repetir fases já aprovadas.

**Ver o estado atual sem interromper o loop:**

```
/loop-development-status
```

## O que esperar do fluxo

1. Intake regista o pedido, garante que `.loop-development/` existe e cria uma pasta de plano nova por funcionalidade (`plans/<timestamp>-<slug>/`).
2. Grill-Me conduz uma entrevista iterativa, **uma pergunta de cada vez** (cada resposta influencia a pergunta seguinte). Decisões delegadas são pesquisadas e apresentadas como opções para escolha explícita.
3. Researcher + Planner + Architecture Reviewer produzem um plano.
4. **Paragem obrigatória:** aprovas o plano.
5. Task Generator divide o plano em tarefas; a aprovação do plano aprova automaticamente essa decomposição.
6. A lista de tarefas é apresentada apenas como resumo informativo. Se não houver desvios ao plano, a execução começa automaticamente.
7. A partir daqui, o loop corre **sozinho**, tarefa a tarefa: implementa, refatora, escreve testes, corre verificações (testes/typecheck/lint/prettier/segurança/performance), corrige até tudo passar, documenta, faz commit, persiste estado, sem te voltar a interromper entre tarefas, a não ser que surja uma ambiguidade genuína fora do que foi aprovado.
8. No fim, Final Reviewer faz uma revisão global e o Loop Development reporta um resumo final. (No modo `simple` não há Final Reviewer nem passos por tarefa além de implementar e persistir estado — toda a verificação acontece no fim do plano; ver *Modos de execução*.)

> **Sobre o Grill-Me:** no fluxo, o `grill-me` executado é o **agente do pacote**, invocado pelo orquestrador via a acção `subagent` (e também acessível com `@grill-me`). É independente de qualquer skill do utilizador com o mesmo nome — o agente tem acesso à tool `skill` negado, pelo que as instruções dele vêm sempre do pacote, não de skills instaladas (ex: `~/.agents/skills/grill-me/`).

## Modos de execução

Existem exatamente dois modos fixos, pensados para controlar quanto contexto/tokens cada plano consome:

- **`complete`** (default) — o fluxo integral: research, revisão de arquitetura, compaction e, por tarefa: context loader, dependency auditor, refactorer, test writer, verifier, auditores de segurança/performance, documentation writer, git manager e compacter; no fim, final reviewer.
- **`simple`** — fluxo enxuto para planos gratuitos ou funcionalidades pequenas: Grill-Me completo → planeamento → aprovação → implementação tarefa a tarefa (só implementer + state-manager) → no fim do plano, test writer uma única vez + verificação final completa (build, suite, cobertura, typecheck, lint, prettier) com loop de correção → commit único do plano.

| Passo | `complete` | `simple` |
|---|---|---|
| Intake + Grill-Me (incluindo pesquisas direcionadas) | ✅ | ✅ |
| Research autónomo + Architecture Reviewer | ✅ | ❌ |
| Compacter | ✅ | ❌ |
| Aprovação do plano (paragem obrigatória) | ✅ | ✅ |
| Por tarefa: Context Loader, Dependency Auditor, Refactorer, Test Writer, Verifier, Security/Performance Auditor, Documentation Writer, Git Manager, Compacter | ✅ | ❌ |
| Por tarefa: Implementer + State Manager | ✅ | ✅ |
| No fim: Test Writer (plano inteiro) | ❌ (já correu por tarefa) | ✅ |
| Verificação final do plano (Verifier modo plano, com cobertura mínima) | ✅ | ✅ |
| Git Manager no fim (commit único) | ❌ (commits por tarefa) | ✅ |
| Final Reviewer | ✅ | ❌ |

Regras dos modos:

- O modo fica gravado no campo `mode` do `state.json` do plano à criação e é **imutável** — `/loop-development-continue` retoma sempre com o modo gravado.
- O default para planos novos vem de `default_mode` no `.loop-development/state.json` (`complete` se ausente). Muda-o sem editar ficheiros:

```bash
npx loop-development set-mode simple      # ou complete
npx loop-development set-mode simple --dry-run
```

- `set-mode` só afeta **planos novos**; o plano ativo mantém o modo com que foi criado.
- Para usar o modo simple num pedido pontual sem mudar o default, usa o comando `/loop-development-simples <pedido>`.
- A única paragem obrigatória em ambos os modos é a aprovação do plano. Promover um plano `simple` a `complete` a meio só acontece com a tua aprovação explícita.

## Estado persistente (por planos)

A memória do Loop Development vive em `.loop-development/`, separada em dois níveis:

**Nível de projeto** (partilhado por todas as funcionalidades):

- `state.json` — fino: plano ativo (`active_plan`), registo dos planos (`plans[]` com id/nome/estado) e configuração (`min_coverage`, `default_mode`).
- `project-summary.md` — resumo vivo do que o projeto é e faz.
- `architecture.md` — decisões de arquitetura validadas.
- `changelog.md` — changelog do projeto.
- `risks.md` — riscos (podem atravessar funcionalidades).

**Nível de plano** — uma pasta por funcionalidade em `plans/<YYYYMMDD.HHMM-<slug>>/`:

- `state.json` — fase, tarefa em curso e listas `tasks_done`/`tasks_pending` do plano.
- `spec.md` — especificação/plano aprovado da funcionalidade.
- `decisions.md` — ADRs curtos específicos da funcionalidade.
- `clarifications.md` — histórico persistente do Grill-Me, pesquisas direcionadas e decisões confirmadas.
- `implementation-log/` — histórico com shards mensais (`YYYY-MM.md`) + `index.md`; o Context Loader lê só o shard relevante.
- `tasks/` — uma tarefa por ficheiro (`001-<slug>.md`).
- `summaries/` — resumos de sessões produzidos pelo Compacter.
- `metrics/` — métricas por tarefa (`<task-id>.json`).

Quando existe apenas um plano, o formato antigo (flat) é convertido automaticamente na primeira invocação — ou manualmente com `npx loop-development migrate`.

### Contrato de conteúdo do `architecture.md`

O `architecture.md` é a **base estrutural geral** do projeto, não um log da implementação. Pertencem-lhe: stack e versões, regras/convenções de codificação, estrutura de pastas de alto nível e decisões de arquitetura transversais. **Nunca** devem constar: fase do projeto/roadmap, funções específicas de features, justificações tipo "porque é MVP", migrações/scripts SQL de tarefas ou listas de implementações — esses detalhes vivem em `plans/<id>/` e no `implementation-log/`. O Planner Writer faz **poda incondicional** ao atualizar o ficheiro (remove o que viola o contrato antes de adicionar, idempotente), e o Final Reviewer valida o resultado. Podes auditar qualquer projeto (mesmo sem correr um plano) com `loop-development architecture check`.

### Segredos e variáveis de ambiente

Os agentes **nunca** documentam valores reais de variáveis de ambiente (chaves, tokens, senhas, connection strings) — apenas o **nome** e **onde** está configurada; `.env.example` usa placeholders. O `init --project` garante que `.env`/`.env.*` estão no `.gitignore`. Para auditar um projeto (working tree ou histórico git), usa `loop-development secrets check [--history]`; se um segredo já estiver commitado, `loop-development secrets purge` reescreve o histórico com `git filter-repo` (requer confirmação e, depois, **rotação** do segredo). Padrões adicionais por projeto: `.loop-development/secret-patterns.jsonc`.

### Verificação por tarefa vs verificação final

Cada tarefa corre apenas a verificação leve: testes **afetados** + typecheck + lint + prettier. O **build** e a **suite completa** (incluindo o gate de cobertura) correm uma única vez na **verificação final do plano**, antes do Final Reviewer, com loop de correção. A matriz é configurável em `.loop-development/state.json` → `verification: { per_task: [...], final: [...] }`.

## Modelos e camadas (tiers)

Por defeito usa modelos **gratuitos** do OpenCode Zen, agrupados em 4 camadas, cada agente tem um comentário `# tier: <nome>` junto ao campo `model` no seu ficheiro:

| Tier | Agentes | Modelo default |
|---|---|---|
| `reasoning` | loop-development, grill-me, researcher, planner, architecture-reviewer, security-auditor, performance-auditor, final-reviewer | `opencode/big-pickle` |
| `coding` | implementer, refactorer, test-writer, task-generator | `opencode/big-pickle` |
| `docs` | planner-writer, documentation-writer | `opencode/ling-3.0-tiny-free` |
| `mechanical` | intake, dependency-auditor, context-loader, verifier, git-manager, state-manager, compacter | `opencode/deepseek-v4-flash-free` |

**Importante:** os modelos gratuitos do OpenCode Zen rodam com frequência (promoções que terminam, modelos que saem/entram). Antes de confiar nestes IDs, corre `/models` no OpenCode para confirmares o que está disponível como gratuito neste momento. Se algum destes IDs já não existir, troca-o — o `set-model` avisa se o modelo estiver deprecated ou não constar no models.dev, e `loop-development models` audita todos os agentes instalados contra o catálogo.

Para trocar os modelos de vários tiers numa só execução:

```bash
npx loop-development set-model --reasoning anthropic/claude-opus-4-8 --coding opencode/big-pickle
npx loop-development set-model --all opencode/big-pickle
npx loop-development set-model --defaults
npx loop-development models
```

Os tiers omitidos numa operação com flags permanecem inalterados. `--dry-run` mostra todas as alterações sem escrever arquivos. A sintaxe antiga `set-model <tier> <modelo>` continua disponível.

## Autonomia e permissões

Dentro do ciclo de uma tarefa (implementação, testes, lint, prettier), o **shell está em `allow` por defeito em todos os agentes**: o loop não para para pedir permissão em cada comando (npm, pnpm, node, git add/commit/log, etc.). As únicas paragens manuais garantidas são a aprovação do **plano** e da **lista de tarefas**, mais os **comandos destrutivos** (lista em baixo) que pedem aprovação mesmo dentro do ciclo.

### Como o OpenCode V2 lê as permissões

Em V1 as permissões eram mapas `agent.<id>.permission.<acção>` com pares padrão→efeito. Em V2 são **listas ordenadas de regras** `{ action, resource, effect }` num array `permissions` — de topo no config global e por agente em `agents.<id>.permissions`. Três consequências que mudam o que se pode escrever no teu config:

- **As acções foram renomeadas:** `bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`.
- **As regras anexam e a última que casa ganha.** Não existe "as regras do agente prevalecem sobre o global": as listas de todos os âmbitos aplicam-se em conjunto e o vencedor depende da ordem. É por isso que o grant broad `"*": "allow"` tem de ser inserido *antes* das exceções específicas — o installer faz essa inserção sensível à ordem, não um append cego.
- **O `.md` é a única fonte das permissões internas dos nossos agentes.** Cada agente declara o seu `permissions:` no frontmatter (`subagent` com `deny` em `"*"` e `allow` por subagente conhecido, `read`/`glob`/`edit` sobre `.loop-development/**`, `edit`/`webfetch`/`skill`/`question` consoante o papel). O config global **não** volta a duplicar isto: em V1 a duplicação era inofensiva (dois mapas mesclavam por chave), mas em V2 as duas listas aplicam-se em conjunto e, se divergissem, o vencedor dependia da ordem de carga. No `opencode.json` global ficam só as guardas de shell de topo; as regras por-agente só entram no `opencode.json` do **projeto** (grants de projeto), que são legitimamente config-level.

**Pasta `.loop-development/` pré-autorizada:** cada agente declara no seu frontmatter `read`/`glob` em `allow` para `.loop-development/**`, e `edit` em `allow` nos que também escrevem estado (loop-development, context-loader, state-manager, planner-writer, task-generator, compacter, refactorer, documentation-writer, final-reviewer). Assim, o fluxo lê e atualiza o estado sem pedir permissão na primeira execução. Uma regra tua mais específica continua a ganhar se vier **depois** (ordem conta) — o installer não toca em regras tuas, em nenhum sentido.

**Default de shell com comandos destrutivos a pedir aprovação:** a instalação escreve no `opencode.json` o array `permissions` de topo com `{ "action": "shell", "resource": "*", "effect": "allow" }` e a lista de padrões destrutivos em `ask`. Como as permissões internas vivem no `.md`, nenhum dos nossos agentes declara `shell` — por isso o default aplica-se a todos eles. Para restringir um agente específico, acrescenta uma regra `shell` em `agents.<id>.permissions` no `opencode.json` (ou no `permissions:` do `.md`); para desligar um padrão global, apaga-o do array ou muda o `effect` para `allow`.

**Merge sempre aditivo:** o installer identifica uma regra por `action`+`resource`. Se essa regra já existir, não é sobrescrita: se o `effect` for igual, nada muda; se for diferente, é um **conflito** — o teu valor fica e o install imprime o conflito. Nunca removemos nem reordenamos regras tuas. (Overwrite exigiria remover a tua e reinseri-la, o que mudaria a ordem relativa face ao resto das regras.)

**Comandos destrutivos (pedem aprovação):**

- git: `push`, `reset --hard`, `clean`, `checkout`, `switch`, `rebase`, `merge`, `branch -D`, `stash drop`;
- ficheiros: `rm`, `rmdir`, `unlink`, `truncate`;
- sistema/processos: `sudo`, `shutdown`/`reboot`/`poweroff`, `kill -9`, `pkill`, `killall`, `dd`, `mkfs`, `fdisk`;
- pacotes: `npm uninstall`, `yarn remove`, `pnpm remove`, `bun remove`, `pip uninstall`;
- docker: `rm`, `rmi`, `system prune`, `volume rm`, `compose down`;
- infra: `terraform destroy`, `tofu destroy`.

O `git-manager` herda este default: comandos de leitura/`add`/`commit` correm sem pedir; `push`, `checkout`, `switch`, `merge`, `rebase`, `branch -D` e `reset --hard` pedem aprovação — o que materializa a regra dele de "nunca faz push nem muda de branch sem instrução explícita".

Na atualização, o installer **limpa** o que versões antigas do pacote tinham gerado: as regras `shell` por-agente registadas no manifesto e o artefacto inválido `agents.permission`. E, se o teu config ainda estiver em forma V1 (`agent`, mapas `permission`), converte-o — ver *Migrar de V1 para V2*.

Se em algum projeto quiseres mais controlo (ex: `edit` em `ask` também dentro do ciclo), ajusta o bloco `permissions:` no frontmatter do ficheiro do agente relevante em `~/.config/opencode/agents/` (ou as regras em `agents.<id>.permissions` no `opencode.json` do projeto).

## Aprovações remotas via Telegram

O Loop Development inclui um plugin opcional que envia os **pedidos de permissão** para um bot do Telegram, para poderes aprovar a partir do telemóvel.

As **perguntas** (tool `question`) são outro caso: em V2 são forms e o V2 não expõe um domínio `question`/`form` a plugins de servidor (só a API de CLI/TUI tem `session.form.reply`). Como o Telegram tem de funcionar 24/7, independente de o TUI estar aberto, o plugin continua a ser server plugin e as perguntas chegam apenas como **notificação sem botões**, com instrução de abrir o TUI para responder.

**1. Cria o bot** no [@BotFather](https://t.me/BotFather) e guarda o token.

**2. Configura o plugin:**

```bash
npx loop-development telegram setup --token <TOKEN>
```

O setup verifica o token, guarda a chave de emparelhamento e mostra as instruções para autorizar o teu chat. Alternativas ao `--token`: a env `OPENCODE_TELEGRAM_BOT_TOKEN`, ou gerar/reutilizar a chave com `--pairing-key <chave>`. Com `--reset` começa de novo. O estado fica em `~/.config/opencode/telegram-state.json`.

**3. Emparelha o chat:** abre o bot no Telegram e envia `/start <chave>` (vista em `loop-development telegram status`). Só chats autorizados recebem notificações ou podem responder.

A partir daí, cada pedido de permissão chega ao Telegram:
- permissões: botões **Aprovar / Sempre / Rejeitar** (o "Sempre" pede confirmação dos padrões). A resposta usa `ctx.permission.reply({ sessionID, requestID, decision })` — o campo é `decision`, não `reply`;
- perguntas: **só notificação**, sem botões e sem resposta remota — responde no TUI.

Estado atual: `loop-development telegram status` · Remover: `loop-development telegram reset`.

> O polling usa long-polling (`getUpdates`), por isso não precisa de portas públicas, e tem limite de 1 instância por bot (409 encerra o polling para evitar processamento duplicado).

## Acesso a pastas externas e ligação main/child

### Pastas externas permitidas

O opencode bloqueia por defeito o acesso a ficheiros fora da raiz do projeto. Para autorizar uma pasta externa (ex: um diretório partilhado, um recurso de outro projeto), usa a lista canónica:

```bash
npx loop-development allow add C:/Users/teu-user/recursos
npx loop-development allow list
npx loop-development allow remove C:/Users/teu-user/recursos
npx loop-development allow clear
```

O `allow add` valida que a pasta existe, grava a referência em `.loop-development/allowed-folders.json` e escreve de forma **aditiva** regras `{ "action": "external_directory", "resource": "<caminho>", "effect": "allow" }` no array `permissions` de topo do `opencode.json` do projeto (padrões `<caminho>` e `<caminho>/**`, com backup `opencode.json.bak-loop-development`). Regras manuais que já tenhas em `external_directory` nunca são sobrepostas; `remove`/`clear` só apagam padrões que o Loop Development gerou. Caminhos são normalizados (absolutos, forward slashes, `~` expandido). `--dry-run` mostra as alterações sem escrever.

> O mecanismo usa a acção nativa `external_directory` do opencode (no V2 deixou de ser o mapa `permission.external_directory` e passou a ser uma regra `action: "external_directory"` no array `permissions`): dentro do projeto os defaults do workspace continuam a valer e ficheiros `.env` continuam a pedir aprovação.

### Ligação automática main/child

Quando um projeto vive dentro de outro (monorepos, sub-projetos), o Loop Development liga-os automaticamente para o child poder ler o contexto mínimo do main:

- **Parent/children** ficam em `.loop-development/state.json` (`parent` no child, `children[]` no main) — o `link` deteta o ancestral mais próximo com `.loop-development/` (sobe até 5 níveis) e os children diretos (profundidade 1, ignorando `node_modules`, `.git` e pastas ocultas).
- O child recebe **acesso de leitura à raiz do main** via regras `external_directory` no `opencode.json` do child e o Context Loader passa a ler `architecture.md`, `state.json` e `project-summary.md` do main (só leitura) ao carregar contexto.
- Cadeias são suportadas: um child pode ser main de outro child.
- Automático: o `init --project` corre o `link` no final e o Intake corre `npx loop-development link` em cada novo plano (idempotente). Para desativar no init: `--no-link`.

```bash
npx loop-development link        # dentro do child: liga ao main e reconcilia stale
npx loop-development unlink ../main   # remove a ligação (estado + grants)
npx loop-development status      # mostra parent/children e contagem de pastas permitidas
```

## Títulos de sessão com o nome do plano ativo

O Loop Development inclui um plugin que renomeia automaticamente as sessões do opencode com o nome do plano ativo de `.loop-development/state.json` (ex: `20260808.2246-login-google` → **Login Google**), para conseguires ver a funcionalidade em curso na lista de sessões sem abrir cada uma.

O comportamento é controlado por `~/.config/opencode/session-title.jsonc` (tudo opcional):

```jsonc
{
  "enabled": true,                  // ativa/desativa o rename automático
  "agents": ["loop-development"],   // agentes cujas sessões são renomeadas
  "prefix": "",                     // texto antes do nome do plano
  "suffix": "",                     // texto depois do nome do plano
  "mode": "first",                  // "first" | "always" | "never"
  "debug": false                    // log detalhado de cada decisão
}
```

Modos de `mode`:
- `first` (default): sobrescreve o título na 1ª vez e mantém-no enquanto for o que o plugin escreveu (ou um "Nova sessão"). Trocar de plano a meio da sessão atualiza o título; renomes manuais ficam intactos.
- `always`: sobrepõe sempre que o plano ativo mudar.
- `never`: só define o título quando a sessão ainda tem o default.

O estado (último título definido por sessão) vive no **`ctx.storage` do próprio plugin**, sob a chave `titles` — é durável e fica scoped pelo id do plugin, por isso renomes manuais continuam respeitados entre reinícios. Já **não** existe `.loop-development/session-titles.json` no projeto, e o `init --project` **não** escreve essa entrada no `.gitignore` (só `.env`, `.env.*` e `!*.env.example`).

> **A atualizar de versões antigas**: os plugins anteriores de rename de sessão estão quebrados e devem ser removidos à mão — apaga `~/.config/opencode/plugins/session-auto-rename.ts` e retira `"opencode-session-auto-rename"` do array `plugin` do teu `opencode.json`, depois corre `npx loop-development update` e reinicia o opencode.

## Plugins (formato OpenCode V2)

Os dois plugins (`session-title`, `telegram`) são ficheiros `.ts` locais em `~/.config/opencode/plugins/`, autoconsiderados pelo OpenCode, e ambos seguem o formato V2:

- **default export** com `{ id, setup }` — `export default plugin`. O V1 usava *named* exports, e o loader V2 simplesmente **não carregava** o ficheiro (o sintoma aparecia no log como `failed to load plugin` … `Missing key at ["default"]`). É esta a razão do requisito de V2;
- `setup(ctx)` devolve a função de cleanup (o plugin aborta o `AbortController` do `ctx.event.subscribe({ signal })` ao sair);
- todo o estado é **closure do `setup`** — no V2 os plugins são instanciados por localização, portanto estado a nível de módulo seria partilhado entre instâncias;
- eventos são filtrados por `ctx.location.directory` (o stream é global);
- **sem dependências de runtime**: o único import de `@opencode/plugin` é `import type`, apagado em runtime. A pasta de config do OpenCode nunca precisa de `node_modules`.

Hooks usados: `ctx.session.hook("context", …)` no session-title (o `chat.message` do V1 **não existe** em V2; o hook de contexto expõe o agente activo da sessão), `ctx.session.get`/`ctx.session.update` para o título, `ctx.permission.reply` no telegram.

## Migrar de V1 para V2

Se vinhas do Loop Development anterior (`0.x`) ou tens config/agentes em forma V1, o upgrade é:

```bash
npx loop-development doctor        # 1. Diagnostica (não altera nada)
npx loop-development update        # 2. Migra config V1→V2 e re-sincroniza os agentes
npx loop-development doctor --fix  # 3. Repara o que for automático
# reinicia o OpenCode
```

O `update` faz a migração sozinho, em ambos os sentidos (config global e config de projeto), sempre com backup (`*.bak-loop-development`) e relatório do que converteu:

| V1 | V2 |
|---|---|
| `agent.<id>` | `agents.<id>` |
| `agent.<id>.permission.<acção>` (mapa padrão→efeito) | `agents.<id>.permissions` (array de `{ action, resource, effect }`) |
| `permission` (mapa, no topo) | `permissions` (array ordenado, no topo) |
| `permission.bash` (mapa) | regras `action: "shell"` no array `permissions` |
| `permission.external_directory` (mapa) | regras `action: "external_directory"` no array `permissions` |
| acção `bash` | `shell` |
| acção `task` | `subagent` |
| acções `write` / `patch` | `edit` |
| frontmatter `permission:` nos `.md` | frontmatter `permissions:` (array) |
| frontmatter `tools:` | removido (obsoleto) |
| frontmatter `temperature:` | `request.body.temperature` — **ver ressalva abaixo** |
| plugin com *named* export | plugin com `export default { id, setup }` |
| manifesto com chaves e `files: string[]` | manifesto v2: regras com identidade `action`+`resource` e `files: [{ path, sha256, shippedIn }]` |

O que o `update` **não** faz: não sobrescreve um ficheiro que tenhas editado à mão (só com `--force`), não remove regras tuas e não reordena nada. Se uma regra tua colidir com uma gerida (mesmo `action`+`resource`, `effect` diferente), reporta o conflito e mantém a tua.

## Diagnóstico: `loop-development doctor`

```bash
npx loop-development doctor [--fix] [--dir <dir>] [--config-dir <dir>]
```

Seis verificações, em sequência, com `--dry-run` a não alterar nada:

1. **Versão do OpenCode** — corre `opencode --version` e falha se ainda for V1;
2. **Manifesto** — versão instalada vs. versão do pacote, versão do formato do manifesto, ficheiros embarcados em falta e hashes stale;
3. **Forma do config** — detecta chaves V1 (`agent`, `permission` como objeto) que o V2 ignora silenciosamente;
4. **Frontmatter dos agentes** — detecta `permission:`, `temperature:` e `tools:` (chaves V1) nos `.md` instalados;
5. **Plugins** — verificação estática de que existe `export default`, **e** leitura de `~/.local/share/opencode/log/opencode.log` à procura de `failed to load plugin` recente que mencione os nossos caminhos. O log é a fonte de verdade: um `-` na coluna VERSION do `plugin list` não é sinal de falha;
6. **Dependências** — confirma `@opencode/plugin`, `typescript` e `@types/node` (as `VERIFY_DEPS`). Fora de um checkout de desenvolvimento reporta que não há nada a verificar, em vez de um falso "tudo OK".

**Exit code:** 0 se tudo estiver em ordem, **!= 0** se alguma verificação falhar (pronto para CI). `--fix` repara o que for automático — dependências em falta (com o package manager detetado) e a migração do config. Quando algo não é reparável, o comando diz como resolver (por exemplo `corre 'loop-development update'`).

> **Ressalva sobre a temperatura.** Os 21 agentes trazem `temperature` no frontmatter sob `request.body.temperature` — a forma correta para o futuro. Só que o runner de sessões do V2 **preserva estes valores mas ainda não os envia** nos pedidos ao modelo (*"The V2 session runner preserves these values but does not yet send them with model requests"*, OpenCode v2.0.11). Ou seja: **as temperaturas por agente não são aplicadas hoje.** A migração não perdeu nada (já não eram aplicadas no V1 também), mas se dependias de temperaturas diferenciadas por tier, não esperes esse efeito até o OpenCode os enviar.

## Desenvolvimento

```bash
npm test              # corre a suíte (node --test)
npm run typecheck     # tsc -p tsconfig.json — typecheck dos .ts dos plugins
npm run doctor        # o mesmo diagnóstico do CLI, a partir deste checkout
npm pack --dry-run    # mostra o conteúdo que seria publicado
```

As dependências de verificação (`@opencode/plugin`, `typescript`, `@types/node`) estão em `devDependencies` e o script `prepare` (`bin/ensure-deps.js`) instala-as em falta sem nunca falhar a instalação do pacote. Os plugins em si **não têm dependências de runtime**.

### Publicação

O pacote é publicado via GitHub Actions + `semantic-release` no branch `main`, com commits em conventional commits. Precisa de um repositório GitHub e de um `NPM_TOKEN` de automação, guardado no environment **"Production"** do repositório — o job `release` declara `environment: production`, que é o que torna o secret visível ao workflow (secrets de um environment só são expostos a jobs que o referenciam). Se a env tiver *required reviewers*, cada release fica a aguardar aprovação manual.

A **versão é atualizada automaticamente** (`.releaserc.json`): em cada release o semantic-release committa a versão nova em `package.json`/`package-lock.json`, gera `CHANGELOG.md`, e cria o tag/Release no GitHub. A primeira release será `1.0.0`.

Publicação manual, se necessário:

```bash
npm publish
```

## Licença

MIT
