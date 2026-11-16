#!/usr/bin/env bash
# Sourced by deploy.sh. Pure preflight: never writes, prints Compose contents,
# starts containers or changes the running deployment.
#
# Select the live container's Compose overlays for the next candidate.
# Skip generated image overrides as before. Skip historical candidate
# overrides ONLY when their bytes match the reviewed current template.
# If an old candidate differs, fail closed: it may contain runtime settings
# that must be reviewed before replacing it, not silently accumulated.
#
# Usage: select_live_compose_files "$FILES_LABEL" "$DIR/candidate.override.yml" "$STATE_DIR"
# Output: COMPOSE_ARGS=(-f <file> ...), preserving original order.
select_live_compose_files() {
  local files_label="$1" candidate_override="$2" state_dir="$3" file
  local -a labeled_files=() selected=()
  COMPOSE_ARGS=()

  if [ ! -f "$candidate_override" ] || [ ! -r "$candidate_override" ] || [ -L "$candidate_override" ]; then
    printf 'ABORT: current candidate override is missing, unreadable or a symlink: %s\n' "$candidate_override" >&2
    return 1
  fi
  if [ -z "$files_label" ]; then
    printf 'ABORT: live Compose labels contain no config files\n' >&2
    return 1
  fi

  IFS=',' read -r -a labeled_files <<<"$files_label"
  for file in "${labeled_files[@]}"; do
    if [ -z "$file" ]; then
      printf 'ABORT: empty file in live Compose labels\n' >&2
      return 1
    fi
    case "$file" in
      # Existing generated release image overrides must be replaced.
      */new-image-override.yml|"$state_dir"/*-image-override.yml)
        continue
        ;;
      # The current candidate is always appended last by deploy.sh.
      # Legacy candidates were stored at .../ops/candidate.override.yml.
      # Never treat arbitrary *.override.yml as a disposable candidate.
      "$candidate_override"|*/ops/candidate.override.yml)
        if [ ! -f "$file" ] || [ ! -r "$file" ] || [ -L "$file" ]; then
          printf 'ABORT: previous candidate overlay missing, unreadable or symlink: %s\n' "$file" >&2
          return 1
        fi
        if ! cmp -s -- "$file" "$candidate_override"; then
          printf 'ABORT: previous candidate overlay differs from current template: %s (operator must review before deploy)\n' "$file" >&2
          return 1
        fi
        continue
        ;;
    esac
    # Keep production, BSUID and every other overlay exactly as labeled.
    if [ ! -f "$file" ] || [ ! -r "$file" ]; then
      printf 'ABORT: live Compose file missing or unreadable: %s\n' "$file" >&2
      return 1
    fi
    selected+=(-f "$file")
  done

  if [ "${#selected[@]}" -eq 0 ]; then
    printf 'ABORT: no base Compose configuration remains after filtering\n' >&2
    return 1
  fi
  COMPOSE_ARGS=("${selected[@]}")
}
