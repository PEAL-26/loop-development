#!/usr/bin/env bash
# Atualiza os modelos dos agentes por tier.
#
# Uso:
#   ./scripts/set-model.sh coding provider/model-id
#   ./scripts/set-model.sh --reasoning provider/model-id --coding provider/model-id
#   ./scripts/set-model.sh --all provider/model-id
#   ./scripts/set-model.sh --defaults

set -euo pipefail
shopt -s nullglob

TIERS=(reasoning coding docs mechanical)
declare -A MODELS
declare -A MATCHED
declare -A CHANGED_BY_TIER
for tier in "${TIERS[@]}"; do
  CHANGED_BY_TIER["$tier"]=0
done

DRY_RUN=0
MODE_COUNT=0
MODEL_ALL=""
USE_DEFAULTS=0

die() {
  echo "erro: $*" >&2
  exit 1
}

validate_model() {
  [[ "$1" =~ ^[^[:space:]/]+/[^[:space:]/]+$ ]] || die "modelo inválido: '$1'. Usa o formato provider/model-id."
}

if [[ "${1:-}" != --* ]]; then
  [[ "$#" -eq 2 ]] || die "Uso: $0 <tier> <provider/model-id>"
  case "$1" in
    reasoning|coding|docs|mechanical) MODELS["$1"]="$2" ;;
    *) die "tier inválido '$1'. Válidos: reasoning, coding, docs, mechanical" ;;
  esac
  validate_model "$2"
else
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --all)
        [[ "$MODE_COUNT" -eq 0 ]] || die "--all não pode ser combinado com outra modalidade"
        [[ -n "${2:-}" ]] || die "--all requer um modelo"
        MODEL_ALL="$2"
        validate_model "$MODEL_ALL"
        MODE_COUNT=1
        shift ;;
      --defaults)
        [[ "$MODE_COUNT" -eq 0 ]] || die "--defaults não pode ser combinado com outra modalidade"
        USE_DEFAULTS=1
        MODE_COUNT=1 ;;
      --reasoning|--coding|--docs|--mechanical)
        [[ "$MODE_COUNT" -eq 0 || "$MODE_COUNT" -eq 2 ]] || die "flags de tier não podem ser combinadas com --all ou --defaults"
        tier="${1#--}"
        [[ -n "${2:-}" ]] || die "$1 requer um modelo"
        MODELS["$tier"]="$2"
        validate_model "$2"
        MODE_COUNT=2
        shift ;;
      *) die "opção desconhecida '$1'" ;;
    esac
    shift
  done
  [[ "$MODE_COUNT" -gt 0 ]] || die "especifica --all <modelo>, --defaults ou flags de tier"
  if [[ -n "$MODEL_ALL" ]]; then
    for tier in "${TIERS[@]}"; do MODELS["$tier"]="$MODEL_ALL"; done
  elif [[ "$USE_DEFAULTS" -eq 1 ]]; then
    MODELS[reasoning]="opencode/big-pickle"
    MODELS[coding]="opencode/big-pickle"
    MODELS[docs]="opencode/ling-3.0-tiny-free"
    MODELS[mechanical]="opencode/deepseek-v4-flash-free"
  fi
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../agents" && pwd)"
FILES=("$DIR"/*.md)
[[ "${#FILES[@]}" -gt 0 ]] || die "Nenhum agente encontrado em $DIR. Corre a instalação primeiro."

for tier in "${TIERS[@]}"; do
  [[ -n "${MODELS[$tier]:-}" ]] || continue
  found=0
  for file in "${FILES[@]}"; do
    if grep -q "^# tier: ${tier}$" "$file"; then
      found=1
      MATCHED["$tier"]=1
      break
    fi
  done
  [[ "$found" -eq 1 ]] || die "Nenhum agente encontrado com tier '$tier'"
done

BACKUP_DIR=""
finish() {
  status=$?
  if [[ "$status" -ne 0 && -n "$BACKUP_DIR" ]]; then
    for backup in "$BACKUP_DIR"/*.md; do
      [[ -f "$backup" ]] || continue
      cp -- "$backup" "$DIR/$(basename "$backup")"
    done
    echo "erro: falha ao atualizar modelos; alterações revertidas" >&2
  fi
  [[ -z "$BACKUP_DIR" ]] || rm -rf "$BACKUP_DIR"
  exit "$status"
}
trap finish EXIT

if [[ "$DRY_RUN" -eq 0 ]]; then
  BACKUP_DIR="$(mktemp -d)"
fi

CHANGED=0
for file in "${FILES[@]}"; do
  tier=""
  for candidate in "${TIERS[@]}"; do
    if grep -q "^# tier: ${candidate}$" "$file" && [[ -n "${MODELS[$candidate]:-}" ]]; then
      tier="$candidate"
      break
    fi
  done
  [[ -n "$tier" ]] || continue

  model="${MODELS[$tier]}"
  if grep -F -q -x "model: ${model}" "$file" || ! grep -q "^model: " "$file"; then
    continue
  fi

  name="$(basename "$file")"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "seria atualizado: $name -> $model"
  else
    cp -- "$file" "$BACKUP_DIR/$name"
    temp="$BACKUP_DIR/$name.tmp"
    awk -v model="$model" '{ if ($0 ~ /^model: /) print "model: " model; else print }' "$file" > "$temp"
    mv -- "$temp" "$file"
    echo "atualizado: $name -> $model"
  fi
  CHANGED=$((CHANGED + 1))
  CHANGED_BY_TIER["$tier"]=$((CHANGED_BY_TIER["$tier"] + 1))
done

if [[ "$DRY_RUN" -eq 0 ]]; then
  echo "$CHANGED agente(s) atualizados."
else
  echo "$CHANGED agente(s) seriam atualizados."
fi
for tier in "${TIERS[@]}"; do
  [[ -n "${MODELS[$tier]:-}" ]] || continue
  echo "  $tier: ${CHANGED_BY_TIER[$tier]}"
done
