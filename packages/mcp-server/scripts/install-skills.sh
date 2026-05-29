#!/bin/bash
# Install UPG skills into AI coding tool skill directories
# Run from anywhere: bash /path/to/install-skills.sh
#
# Flags:
#   --no-claudemd         Skip CLAUDE.md awareness snippet
#   --target=claude,cursor  Install for specific IDEs (skip prompt)
#
# Supported targets: claude, cursor, codex, gemini, opencode, kiro

set -e

# ── Auto-detect package location ──────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_SOURCE="$PACKAGE_DIR/skills"
SNIPPET_FILE="$SCRIPT_DIR/claudemd-snippet.md"

# Find project root (git root or current directory)
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

if [ ! -d "$SKILLS_SOURCE" ]; then
  echo "Error: Skills source not found at $SKILLS_SOURCE"
  exit 1
fi

# ── Parse flags ───────────────────────────────────────────────────────────────

NO_CLAUDEMD=false
TARGET_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --no-claudemd)
      NO_CLAUDEMD=true
      ;;
    --target=*)
      TARGET_FLAG="${arg#--target=}"
      ;;
  esac
done

# ── IDE target definitions ────────────────────────────────────────────────────

# Each target: name, directory, has MCP support
declare -a ALL_TARGETS=("claude" "cursor" "codex" "gemini" "opencode" "kiro")

target_dir() {
  case "$1" in
    claude)   echo ".claude/skills" ;;
    cursor)   echo ".cursor/skills" ;;
    codex)    echo ".codex/skills" ;;
    gemini)   echo ".gemini/skills" ;;
    opencode) echo ".opencode/skills" ;;
    kiro)     echo ".kiro/skills" ;;
  esac
}

target_label() {
  case "$1" in
    claude)   echo "Claude Code" ;;
    cursor)   echo "Cursor" ;;
    codex)    echo "Codex CLI" ;;
    gemini)   echo "Gemini CLI" ;;
    opencode) echo "OpenCode" ;;
    kiro)     echo "Kiro" ;;
  esac
}

# ── Select targets ────────────────────────────────────────────────────────────

SELECTED_TARGETS=()

if [ -n "$TARGET_FLAG" ]; then
  # Parse comma-separated targets from flag
  IFS=',' read -ra SELECTED_TARGETS <<< "$TARGET_FLAG"
else
  # Interactive prompt
  echo ""
  echo "  · ·"
  echo "   ◉"
  echo "  · ·"
  echo ""
  echo "UPG Skills Installer"
  echo "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄"
  echo ""
  echo "Where do you want to install UPG skills?"
  echo ""
  echo "  1) Claude Code only (.claude/skills/)"
  echo "  2) Claude Code + Cursor (.claude/skills/ + .cursor/skills/)"
  echo "  3) Claude Code + all supported IDEs"
  echo "  4) Pick specific IDEs"
  echo ""
  echo "Supported: Claude Code, Cursor, Codex CLI, Gemini CLI, OpenCode, Kiro"
  echo ""
  printf "Choice [1]: "
  read -r choice

  case "${choice:-1}" in
    1)
      SELECTED_TARGETS=("claude")
      ;;
    2)
      SELECTED_TARGETS=("claude" "cursor")
      ;;
    3)
      SELECTED_TARGETS=("${ALL_TARGETS[@]}")
      ;;
    4)
      echo ""
      echo "Select IDEs (comma-separated, e.g. claude,cursor,gemini):"
      echo "  Available: ${ALL_TARGETS[*]}"
      printf "> "
      read -r picks
      IFS=',' read -ra SELECTED_TARGETS <<< "$picks"
      ;;
    *)
      SELECTED_TARGETS=("claude")
      ;;
  esac
fi

# Validate targets
VALID_TARGETS=()
for t in "${SELECTED_TARGETS[@]}"; do
  t="$(echo "$t" | tr -d ' ')"  # trim whitespace
  dir="$(target_dir "$t")"
  if [ -n "$dir" ]; then
    VALID_TARGETS+=("$t")
  else
    echo "Warning: Unknown target '$t', skipping"
  fi
done

if [ ${#VALID_TARGETS[@]} -eq 0 ]; then
  echo "Error: No valid targets selected"
  exit 1
fi

# ── Count skills ──────────────────────────────────────────────────────────────

SKILL_COUNT=0
for skill_dir in "$SKILLS_SOURCE"/upg*; do
  [ -d "$skill_dir" ] && SKILL_COUNT=$((SKILL_COUNT + 1))
done

# ── Install skills ────────────────────────────────────────────────────────────

echo ""
echo "Installing UPG skills..."
echo "  Source: $SKILLS_SOURCE"
echo ""

HAS_NON_CLAUDE=false

for target in "${VALID_TARGETS[@]}"; do
  dir="$(target_dir "$target")"
  label="$(target_label "$target")"
  full_path="$PROJECT_ROOT/$dir"

  mkdir -p "$full_path"

  echo "  $label → $dir/"

  for skill_dir in "$SKILLS_SOURCE"/upg*; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    target_link="$full_path/$skill_name"

    # Remove existing (symlink or directory)
    if [ -L "$target_link" ]; then
      rm "$target_link"
    elif [ -d "$target_link" ]; then
      rm -rf "$target_link"
    fi

    # Create symlink
    ln -s "$skill_dir" "$target_link"
  done

  echo "    ✓ $SKILL_COUNT skills symlinked"

  if [ "$target" != "claude" ]; then
    HAS_NON_CLAUDE=true
  fi
done

# ── Note about slash commands vs skills for non-Claude IDEs ───────────────────

if [ "$HAS_NON_CLAUDE" = true ]; then
  echo ""
  echo "  Note: /slash-command syntax is Claude Code specific. In other IDEs,"
  echo "  the skill files work as rules/instructions that guide the AI assistant."
  echo "  MCP tools work in any IDE that supports the Model Context Protocol."
fi

# ── CLAUDE.md awareness snippet ───────────────────────────────────────────────

CLAUDEMD_UPDATED=false

if [ "$NO_CLAUDEMD" = false ]; then
  echo ""
  CLAUDEMD_PATH="$PROJECT_ROOT/CLAUDE.md"

  # Check if snippet already exists
  if [ -f "$CLAUDEMD_PATH" ] && grep -q "## Unified Product Graph" "$CLAUDEMD_PATH" 2>/dev/null; then
    echo "  CLAUDE.md already has UPG awareness, skipping"
    CLAUDEMD_UPDATED=true
  else
    printf "Add UPG awareness to your CLAUDE.md? [Y/n] "
    read -r answer

    if [ "${answer:-Y}" != "n" ] && [ "${answer:-Y}" != "N" ]; then
      if [ ! -f "$SNIPPET_FILE" ]; then
        echo "Warning: Snippet file not found at $SNIPPET_FILE, skipping"
      else
        # Create CLAUDE.md if it doesn't exist
        if [ ! -f "$CLAUDEMD_PATH" ]; then
          echo "# $(basename "$PROJECT_ROOT")" > "$CLAUDEMD_PATH"
          echo "" >> "$CLAUDEMD_PATH"
        fi

        # Append snippet
        echo "" >> "$CLAUDEMD_PATH"
        cat "$SNIPPET_FILE" >> "$CLAUDEMD_PATH"
        CLAUDEMD_UPDATED=true
      fi
    fi
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄"

TARGETS_LIST=""
for target in "${VALID_TARGETS[@]}"; do
  label="$(target_label "$target")"
  if [ -z "$TARGETS_LIST" ]; then
    TARGETS_LIST="$label"
  else
    TARGETS_LIST="$TARGETS_LIST, $label"
  fi
done

echo "✓ $SKILL_COUNT skills installed → $TARGETS_LIST"
if [ "$CLAUDEMD_UPDATED" = true ]; then
  echo "✓ CLAUDE.md updated with UPG awareness"
fi
echo ""
echo "Quick start:"
echo "  /upg:          see your product graph"
echo "  /upg-init:     bootstrap a new graph (~5 min)"
echo "  /upg-journey:  guided product journey"
echo ""
echo "Skills are symlinked; edits in the source are live immediately."
echo ""
