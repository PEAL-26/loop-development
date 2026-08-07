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
- mescla no `opencode.json` (ou `opencode.jsonc`) existente as permissões de `task` do agente `loop-development`, **sem sobrescrever** nada do que já tens — com backup em `opencode.json.bak-loop-development`.

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
- `AGENTS.md` — a partir do template.

Depois **edita o `AGENTS.md`** com a stack, comandos reais (testes/lint/typecheck/build) e convenções desse projeto específico — é isto que dá ao Verifier e ao Test Writer comandos reais em vez de adivinhados. Também podes deixar o próprio Intake criar a pasta `.loop-development/` automaticamente na primeira invocação, se preferires não correr o `init --project`.

## Subcomandos do CLI

| Comando | Descrição |
|---|---|
| `loop-development init` | Instala agentes/comandos globalmente (idempotente). |
| `loop-development init --project [dir]` | Prepara um projeto (`.loop-development/` + `AGENTS.md`). |
| `loop-development update` | Re-sincroniza a partir do pacote. |
| `loop-development uninstall` | Remove apenas o que foi instalado pelo Loop Development (usa o manifesto). |
| `loop-development status` | Mostra o estado da instalação e do projeto atual. |
| `loop-development set-model <tier> <modelo>` | Troca o modelo de todos os agentes de uma camada. |
| `loop-development --version` / `--help` | Versão / ajuda. |

Opções comuns: `--yes` (não confirmar), `--force` (sobrescrever existentes), `--dry-run` (mostrar sem alterar), `--config-dir <dir>`.

## Como usar

**Opção A, comando direto (recomendado para arrancar um projeto novo):**

```
/loop-development Quero construir um SaaS de gestão de anúncios para PMEs angolanas, com login, dashboard de campanhas e integração com a Facebook Ads API.
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
2. Grill-Me faz perguntas de clarificação (se houver ambiguidades), respondes tu.
3. Researcher + Planner + Architecture Reviewer produzem um plano.
4. **Paragem obrigatória:** aprovas o plano.
5. Ticket Generator divide o plano em tickets.
6. **Paragem obrigatória:** aprovas a lista de tickets.
7. A partir daqui, o loop corre **sozinho**, ticket a ticket: implementa, refatora, escreve testes, corre verificações (testes/typecheck/lint/prettier/segurança/performance), corrige até tudo passar, documenta, faz commit, persiste estado, sem te voltar a interromper entre tickets, a não ser que surja uma ambiguidade genuína fora do que foi aprovado.
8. No fim, Final Reviewer faz uma revisão global e o Loop Development reporta um resumo final.

## Modelos e camadas (tiers)

Por defeito usa modelos **gratuitos** do OpenCode Zen, agrupados em 3 camadas, cada agente tem um comentário `# tier: <nome>` junto ao campo `model` no seu ficheiro:

| Tier | Agentes | Modelo default |
|---|---|---|
| `reasoning` | loop-development, grill-me, researcher, planner, architecture-reviewer, security-auditor, performance-auditor, final-reviewer | `opencode/big-pickle` |
| `execution` | planner-writer, ticket-generator, implementer, refactorer, test-writer, documentation-writer | `opencode/minimax-m2.5-free` |
| `mechanical` | intake, dependency-auditor, context-loader, verifier, git-manager, state-manager, compacter | `opencode/deepseek-v4-flash-free` |

**Importante:** os modelos gratuitos do OpenCode Zen rodam com frequência (promoções que terminam, modelos que saem/entram). Antes de confiar nestes IDs, corre `/models` no OpenCode para confirmares o que está disponível como gratuito neste momento. Se algum destes IDs já não existir, troca-o.

Para trocar o modelo de uma camada inteira de uma só vez:

```bash
npx loop-development set-model reasoning anthropic/claude-opus-4-8
npx loop-development set-model execution opencode/minimax-m2.5-free
```

(Em bash, o wrapper `~/.config/opencode/scripts/set-model.sh reasoning anthropic/claude-opus-4-8` continua a funcionar.)

## Autonomia e permissões

Dentro do ciclo de um ticket (implementação, testes, lint, prettier), os subagents têm `edit`/`bash` em `allow`, o loop não para para pedir permissão em cada passo. As únicas paragens manuais garantidas são a aprovação do **plano** e da **lista de tickets**.

O `git-manager` só tem `allow` em comandos `git` de leitura, `add` e `commit`; `push`, `checkout`, `branch`, `merge`, `rebase` e `reset` ficam sempre em `ask`.

Se em algum projeto quiseres mais controlo (ex: `edit: ask` também dentro do ciclo), ajusta a `permission` no ficheiro do agente relevante em `~/.config/opencode/agents/`.

## Estrutura deste pacote

```
package.json                  # bin: loop-development, engines: node >= 18
bin/cli.js                    # entrada do CLI (ESM, zero dependências)
src/                          # lógica do instalador (testável)
  install.js                  #   instalação global e scaffold de projeto
  merge-config.js             #   merge aditivo do opencode.json (+ backup)
  manifest.js                 #   manifesto do que foi instalado
  uninstall.js                #   remoção limpa baseada no manifesto
  status.js                   #   estado da instalação e do projeto
  set-model.js                #   troca de modelo por tier (cross-platform)
  config-dir.js               #   resolução do diretório de config
opencode/                     # todos os arquivos do agente
  opencode.json               #   permissões base (mescladas aditivamente)
  agents/                     #   loop-development.md + 20 subagents
  commands/                   #   /loop-development, /continue, /status
  templates/                  #   .loop-development/ + AGENTS.md.template
  scripts/set-model.sh        #   wrapper bash opcional
docs/spec.md                  # especificação original
test/                         # testes (node --test)
```

## Desenvolvimento

```bash
npm test            # corre a suíte (node --test)
npm pack --dry-run  # mostra o conteúdo que seria publicado
```

### Publicação

O pacote é publicado via GitHub Actions + `semantic-release` no branch `main`, com commits em conventional commits. Precisa de um repositório GitHub e de um `NPM_TOKEN` de automação (repo secrets).

Publicação manual, se necessário:

```bash
npm publish
```

## Licença

MIT
