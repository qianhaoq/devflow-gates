#!/usr/bin/env bash
# heal-required-checks.sh — before-merge probe for required checks stuck on
# 'cancelled' / 'expected'.
#
# Branch protection (and the merge API) gate on the LATEST check run per
# required context on the PR head SHA. When that latest run is 'cancelled'
# — or has not appeared yet — the merge fails with 405 "Required status
# check ... is cancelled/expected" even though the change may be
# substantively green. This script re-runs the cancelled run(s) so they
# reach a final state; it NEVER bypasses a check (no protection removal).
#
# Usage:
#   ./scripts/heal-required-checks.sh owner/repo PR_NUMBER [check_name ...]
#
# check_name defaults to the devflow-gates trio; override via arguments or
# the HEAL_REQUIRED_CHECKS env var (newline-separated, same names as
# auto-merge's required_checks input).
#
# Requires a logged-in `gh` (gh auth login). No tokens in this file.
#
# Exit codes:
#   0  every required check is success — safe to merge
#   1  heal re-run(s) triggered, or checks are still not green
#   2  usage or API error
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 owner/repo PR_NUMBER [check_name ...]" >&2
  exit 2
fi

REPO=$1
PR=$2
shift 2

if ! [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "error: REPO must look like owner/repo, got '$REPO'" >&2
  exit 2
fi
if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "error: PR_NUMBER must be numeric, got '$PR'" >&2
  exit 2
fi
command -v gh >/dev/null 2>&1 || { echo "error: gh CLI not found (gh auth login first)" >&2; exit 2; }

if [ "$#" -gt 0 ]; then
  CHECKS=("$@")
elif [ -n "${HEAL_REQUIRED_CHECKS:-}" ]; then
  mapfile -t CHECKS < <(printf '%s\n' "$HEAL_REQUIRED_CHECKS" | grep -v '^[[:space:]]*$' || true)
else
  CHECKS=('ci / Build & Test' 'codex / Codex Review Gate' 'qa / QA Gate')
fi
if [ "${#CHECKS[@]}" -eq 0 ]; then
  echo "error: no check names given (arguments or HEAL_REQUIRED_CHECKS)" >&2
  exit 2
fi

echo "heal-required-checks: $REPO PR #$PR"
SHA=$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha') \
  || { echo "error: could not read PR #$PR in $REPO" >&2; exit 2; }
echo "head SHA: $SHA"

overall=0
for name in "${CHECKS[@]}"; do
  # Latest run for this name on the head (created_at, then id): the same
  # one branch protection gates on. Empty output = no check run yet.
  esc=${name//\\/\\\\}
  esc=${esc//\"/\\\"}
  line=$(gh api "repos/$REPO/commits/$SHA/check-runs?per_page=100" \
    --jq ".check_runs
      | map(select(.name == \"$esc\"))
      | sort_by(.created_at, .id)
      | last
      | if . == null then \"\" else [.status, (.conclusion // \"\"), (.details_url // .html_url // \"\")] | @tsv end") \
    || { echo "error: check-runs API call failed for $SHA" >&2; exit 2; }

  if [ -z "$line" ]; then
    echo "  [$name] missing on head — still expected (waiting for check to appear; do not merge)"
    overall=1
    continue
  fi
  IFS=$'\t' read -r status conclusion url <<<"$line"
  case "$status" in
    completed)
      case "$conclusion" in
        success)
          echo "  [$name] OK (success)"
          ;;
        cancelled)
          if [[ "$url" =~ /runs/([0-9]+) ]]; then
            run_id=${BASH_REMATCH[1]}
            if gh run rerun "$run_id" -R "$REPO"; then
              echo "  [$name] latest is cancelled — heal re-run $run_id triggered; re-check before merging"
            else
              echo "  [$name] latest is cancelled — gh run rerun $run_id FAILED (already running? attempt cap?) — heal in the UI" >&2
            fi
          else
            echo "  [$name] latest is cancelled but has no workflow run link — heal manually in the UI" >&2
          fi
          overall=1
          ;;
        *)
          echo "  [$name] not green: $conclusion"
          overall=1
          ;;
      esac
      ;;
    *)
      echo "  [$name] still expected: status=$status"
      overall=1
      ;;
  esac
done

if [ "$overall" -eq 0 ]; then
  echo "all required checks are success — safe to merge"
else
  echo "not all required checks are green yet (heal triggered or still pending)"
fi
exit "$overall"
