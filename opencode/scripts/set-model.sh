#!/usr/bin/env bash
# Troca o modelo de todos os agentes de uma camada (tier) de uma só vez.
#
# Uso:
#   ./scripts/set-model.sh reasoning anthropic/claude-opus-4-8
#   ./scripts/set-model.sh coding opencode/nemotron-3-ultra-free
#   ./scripts/set-model.sh docs opencode/ling-3.0-tiny-free
#   ./scripts/set-model.sh mechanical opencode/deepseek-v4-flash-free
#   ./scripts/set-model.sh execution opencode/nemotron-3-ultra-free   # alias deprecado de coding
#
# Tiers existentes: reasoning, coding, docs, mechanical
# Corre a partir da raiz do pacote (onde está esta pasta scripts/).

set -euo pipefail

TIER="${1:-}"
MODEL="${2:-}"

if [[ -z "$TIER" || -z "$MODEL" ]]; then
  echo "Uso: $0 <reasoning|coding|docs|mechanical> <provider/model-id>"
  exit 1
fi

if [[ "$TIER" == "execution" ]]; then
  echo "Aviso: o tier 'execution' foi renomeado. Usa 'coding' a partir de agora."
  TIER="coding"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../agents" && pwd)"
CHANGED=0

for f in "$DIR"/*.md; do
  if grep -q "^# tier: ${TIER}$" "$f"; then
    sed -i.bak "s|^model: .*|model: ${MODEL}|" "$f" && rm -f "${f}.bak"
    echo "atualizado: $(basename "$f") -> ${MODEL}"
    CHANGED=$((CHANGED + 1))
  fi
done

if [[ "$CHANGED" -eq 0 ]]; then
  echo "Nenhum agente encontrado com tier '${TIER}'. Tiers válidos: reasoning, coding, docs, mechanical"
  exit 1
fi

echo "${CHANGED} agente(s) atualizados para o tier '${TIER}'."
