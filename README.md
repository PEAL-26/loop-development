# Loop Development para OpenCode

Agente orquestrador global para o OpenCode que conduz todo o ciclo de desenvolvimento de software de forma autónoma, desde o pedido inicial até à conclusão do projeto, coordenando 20 subagents especializados e mantendo estado persistente em `.loop-development/` dentro de cada projeto.

Baseado na especificação [`docs/spec.md`](docs/spec.md).

## Requisitos

- Node.js ≥ 18
- [OpenCode](https://opencode.ai/) instalado

## Instalação

### 1. Instalação global (agentes + comandos + scripts)

```bash
npx loop-development init
```

Instala em `~/.config/opencode/`:

- `agents/` — os 21 agentes (orquestrador + 20 subagents);
- `commands/` — os comandos `/loop-development`, `/loop-development-continue` e `/loop-development-status`;
- `scripts/` — o `set-model.sh` (alternativa em bash ao subcomando `set-model`);
- `templates/` — o esqueleto de estado persistente para novos projetos;
- mescla no `opencode.json` (ou `opencode.jsonc`) existente as permissões do agente `loop-development` (`task` + `read`/`edit`/`glob` em `allow` para `.loop-development/**`, também nos subagentes internos) — com backup em `opencode.json.bak-loop-development`. Os valores geridos são **sobrepostos** se já existirem (ex: `bash: "ask"` passa a `"allow"`), preservando as restantes customizações; nada que o Loop Development não gere é tocado.
- garante `bash: "allow"` nos **agentes de execução** (implementer, refactorer, test-writer, verifier, dependency-auditor, security-auditor, performance-auditor) para que npm/pnpm/etc. não peçam permissão durante a implementação;
- **remove entradas stale** de agentes que o Loop Development já não instala como ficheiros (`implementer`, `verifier`, `loop-triage` em versões antigas), após backup, para não reativarem permissões antigas.

Repetir o comando é seguro (idempotente). Reinicia o OpenCode depois de instalar.

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
- `AGENTS.md` — gerado a partir dos presets de stack que escolheres (ou do template, se escolheres "manual").

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
| `loop-development set-model <tier> <modelo>` | Troca o modelo de todos os agentes de uma camada. |
| `loop-development --list-presets` | Lista os presets de stack disponíveis. |
| `loop-development --version` / `--help` | Versão / ajuda. |

Opções comuns: `--yes` (não confirmar), `--force` (sobrescrever existentes), `--dry-run` (mostrar sem alterar), `--config-dir <dir>`. No `init --project`: `--backend <id>`, `--frontend <id>`, `--pm <npm|pnpm|yarn|bun>` (tornam o fluxo não-interativo).

## Como usar

**Opção A, comando direto (recomendado para arrancar um projeto novo):**

```
/loop-development Cria uma todo list web em React + Vite + Tailwind: adicionar, concluir, editar e remover tarefas, filtros (todas/ativas/concluídas), persistência em localStorage, tema claro/escuro e design limpo e responsivo.
```

**Opção B, agente primário (Tab):**

No TUI/CLI do OpenCode, prime `Tab` para trocar de agente até chegares ao `loop-development`, e conversa normalmente, descreve o que queres construir.

**Retomar trabalho numa sessão nova:**

```
/loop-development-continue
```

Lê `.loop-development/state.json` e continua exatamente de onde ficou, sem repetir fases já aprovadas.

**Ver o estado atual sem interromper o loop:**

```
/loop-development-status
```

## O que esperar do fluxo

1. Intake regista o pedido e garante que `.loop-development/` existe.
2. Grill-Me faz perguntas de clarificação (se houver ambiguidades), **uma pergunta de cada vez** (cada resposta influencia a pergunta seguinte), respondes tu.
3. Researcher + Planner + Architecture Reviewer produzem um plano.
4. **Paragem obrigatória:** aprovas o plano.
5. Ticket Generator divide o plano em tickets.
6. **Paragem obrigatória:** aprovas a lista de tickets.
7. A partir daqui, o loop corre **sozinho**, ticket a ticket: implementa, refatora, escreve testes, corre verificações (testes/typecheck/lint/prettier/segurança/performance), corrige até tudo passar, documenta, faz commit, persiste estado, sem te voltar a interromper entre tickets, a não ser que surja uma ambiguidade genuína fora do que foi aprovado.
8. No fim, Final Reviewer faz uma revisão global e o Loop Development reporta um resumo final.

> **Sobre o Grill-Me:** no fluxo, o `grill-me` executado é o **agente do pacote**, invocado pelo orquestrador via Task (e também acessível com `@grill-me`). É independente de qualquer skill do utilizador com o mesmo nome — o agente tem acesso à tool `skill` negado, pelo que as instruções dele vêm sempre do pacote, não de skills instaladas (ex: `~/.agents/skills/grill-me/`).

## Modelos e camadas (tiers)

Por defeito usa modelos **gratuitos** do OpenCode Zen, agrupados em 3 camadas, cada agente tem um comentário `# tier: <nome>` junto ao campo `model` no seu ficheiro:

| Tier | Agentes | Modelo default |
|---|---|---|
| `reasoning` | loop-development, grill-me, researcher, planner, architecture-reviewer, security-auditor, performance-auditor, final-reviewer | `opencode/big-pickle` |
| `execution` | planner-writer, ticket-generator, implementer, refactorer, test-writer, documentation-writer | `opencode/mimo-v2.5-free` |
| `mechanical` | intake, dependency-auditor, context-loader, verifier, git-manager, state-manager, compacter | `opencode/deepseek-v4-flash-free` |

**Importante:** os modelos gratuitos do OpenCode Zen rodam com frequência (promoções que terminam, modelos que saem/entram). Antes de confiar nestes IDs, corre `/models` no OpenCode para confirmares o que está disponível como gratuito neste momento. Se algum destes IDs já não existir, troca-o.

Nota: o antigo `opencode/minimax-m2.5-free` foi removido do Zen; o sucessor gratuito equivalente é o `opencode/mimo-v2.5-free` (família Xiaomi/MiniMax).

Para trocar o modelo de uma camada inteira de uma só vez:

```bash
npx loop-development set-model reasoning anthropic/claude-opus-4-8
npx loop-development set-model execution opencode/mimo-v2.5-free
```

(Em bash, o wrapper `~/.config/opencode/scripts/set-model.sh reasoning anthropic/claude-opus-4-8` continua a funcionar.)

## Autonomia e permissões

Dentro do ciclo de um ticket (implementação, testes, lint, prettier), os subagents têm `edit`/`bash` em `allow`, o loop não para para pedir permissão em cada passo. As únicas paragens manuais garantidas são a aprovação do **plano** e da **lista de tickets**.

**Pasta `.loop-development/` pré-autorizada:** a instalação adiciona `read`/`edit`/`glob` em `allow` para o padrão `.loop-development/**` no agente `loop-development` e nos subagentes internos (context-loader, state-manager, planner-writer, ticket-generator, compacter, refactorer, documentation-writer, final-reviewer). Assim, o fluxo lê e atualiza o estado sem pedir permissão na primeira execução. Se já tiveres `read`/`edit` com `"ask"` nesses agentes, a regra é mesclada (`{ "*": "ask", ".loop-development/**": "allow" }`) — a tua configuração não é sobrescrita. Tudo o resto do projeto segue a tua configuração.

**Agentes de execução com `bash: allow`:** os agentes que executam código (implementer, refactorer, test-writer, verifier, dependency-auditor, security-auditor, performance-auditor) recebem `bash: "allow"` no `opencode.json` para que comandos de pacotes (npm, pnpm, yarn, bun) e de testes corram sem pedir permissão. Se já tinham `bash: "ask"` (ou um mapa de regras antigo), o valor é **sobreposto** — as restantes chaves desses agentes ficam intactas. Para reverter, muda para `ask` no ficheiro do agente em `~/.config/opencode/agents/` e corre `npx loop-development update` para o installer não voltar a sobrepor.

O `git-manager` só tem `allow` em comandos `git` de leitura, `add` e `commit`; `push`, `checkout`, `branch`, `merge`, `rebase` e `reset` ficam sempre em `ask`.

Se em algum projeto quiseres mais controlo (ex: `edit: ask` também dentro do ciclo), ajusta a `permission` no ficheiro do agente relevante em `~/.config/opencode/agents/`.

## Desenvolvimento

```bash
npm test            # corre a suíte (node --test)
npm pack --dry-run  # mostra o conteúdo que seria publicado
```

### Publicação

O pacote é publicado via GitHub Actions + `semantic-release` no branch `main`, com commits em conventional commits. Precisa de um repositório GitHub e de um `NPM_TOKEN` de automação, guardado no environment **"Production"** do repositório — o job `release` declara `environment: production`, que é o que torna o secret visível ao workflow (secrets de um environment só são expostos a jobs que o referenciam). Se a env tiver *required reviewers*, cada release fica a aguardar aprovação manual.

A **versão é atualizada automaticamente** (`.releaserc.json`): em cada release o semantic-release committa a versão nova em `package.json`/`package-lock.json`, gera `CHANGELOG.md`, e cria o tag/Release no GitHub. A primeira release será `1.0.0`.

Publicação manual, se necessário:

```bash
npm publish
```

## Licença

MIT
