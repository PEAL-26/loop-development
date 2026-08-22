---
description: Retoma o Loop Development a partir do estado persistido em .loop-development/
agent: loop-development
---

Retoma o trabalho a partir do estado persistido. Lê `.loop-development/state.json` para descobrir o plano ativo (`active_plan`) e o estado do plano. Se receberes um argumento com um id de plano e o `active_plan` for diferente, muda o `active_plan` para esse id (via `state-manager`) antes de continuar. Segue sempre o `mode` gravado no plano retomado (`complete` se o campo não existir) — não mudes de modo na retoma. Carrega o contexto necessário (Context Loader) e continua exatamente de onde ficaste — não repitas fases já concluídas nem peças aprovações já concedidas.
