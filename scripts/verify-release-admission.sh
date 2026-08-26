#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_ACTIONS_APP_ID:?GITHUB_ACTIONS_APP_ID is required}"
: "${GOVERNOR_PUBLISHER_ID:?GOVERNOR_PUBLISHER_ID is required}"
: "${GOVERNOR_CONTROL_REPOSITORY:?GOVERNOR_CONTROL_REPOSITORY is required}"
: "${INDEPENDENT_REVIEWER_ID:?INDEPENDENT_REVIEWER_ID is required}"

[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
repository_owner="${GITHUB_REPOSITORY%%/*}"
repository_name="${GITHUB_REPOSITORY#*/}"
test -n "$repository_owner"
test -n "$repository_name"
test "$repository_owner" != "$repository_name"

require_check_run() {
  local check_sha="$1"
  local check_name="$2"
  local workflow_path="$3"
  local expected_event="$4"
  local expected_branch="$5"
  local pages selected details_url run_id workflow_run

  pages="$(gh api --paginate --slurp \
    "repos/${GITHUB_REPOSITORY}/commits/${check_sha}/check-runs?per_page=100")"
  selected="$(jq -c \
    --arg name "$check_name" \
    --argjson app_id "$GITHUB_ACTIONS_APP_ID" \
    '[.[].check_runs[] | select(.name == $name and .app.id == $app_id)]
     | sort_by(.id) | last // null' <<<"$pages")"
  test "$(jq -r '.status // "missing"' <<<"$selected")" = "completed"
  test "$(jq -r '.conclusion // "missing"' <<<"$selected")" = "success"
  details_url="$(jq -r '.details_url // ""' <<<"$selected")"
  [[ "$details_url" =~ /actions/runs/([0-9]+)/job/ ]]
  run_id="${BASH_REMATCH[1]}"
  [[ "$run_id" =~ ^[0-9]+$ ]]

  workflow_run="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}")"
  test "$(jq -r '.id // 0' <<<"$workflow_run")" = "$run_id"
  test "$(jq -r '.head_sha // ""' <<<"$workflow_run")" = "$check_sha"
  test "$(jq -r '.path // ""' <<<"$workflow_run")" = "$workflow_path"
  test "$(jq -r '.event // ""' <<<"$workflow_run")" = "$expected_event"
  test "$(jq -r '.status // ""' <<<"$workflow_run")" = "completed"
  test "$(jq -r '.conclusion // ""' <<<"$workflow_run")" = "success"
  if [ -n "$expected_branch" ]; then
    test "$(jq -r '.head_branch // ""' <<<"$workflow_run")" = "$expected_branch"
  fi
  printf '%s\n' "$run_id"
}

main_check_pages="$(gh api --paginate --slurp \
  "repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/check-runs?per_page=100")"
test "$(jq '[.[].check_runs[]] | length' <<<"$main_check_pages")" -lt 10000

ci_run_id=""
for required_check in \
  "TypeScript — zero errors" \
  "Lint — zero warnings (backend/src/)" \
  "Security audit — no high/critical production vulnerabilities" \
  "Tests — zero failures" \
  "Build Validation"; do
  observed_run_id="$(require_check_run \
    "$GITHUB_SHA" "$required_check" '.github/workflows/ci.yml' push main)"
  if [ -z "$ci_run_id" ]; then ci_run_id="$observed_run_id"; fi
  test "$observed_run_id" = "$ci_run_id"
done

security_run_id=""
for required_check in audit codeql; do
  observed_run_id="$(require_check_run \
    "$GITHUB_SHA" "$required_check" '.github/workflows/security.yml' push main)"
  if [ -z "$security_run_id" ]; then security_run_id="$observed_run_id"; fi
  test "$observed_run_id" = "$security_run_id"
done

associated_pages="$(gh api --paginate --slurp -H 'Accept: application/vnd.github+json' \
  "repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/pulls?per_page=100")"
admitted_pulls="$(jq -c --arg sha "$GITHUB_SHA" --arg repo "$GITHUB_REPOSITORY" \
  '[.[][] | select(
    .merged_at != null and
    .base.ref == "main" and
    .merge_commit_sha == $sha and
    .head.repo.full_name == $repo
  )]' <<<"$associated_pages")"
test "$(jq 'length' <<<"$admitted_pulls")" -eq 1
pr_number="$(jq -r '.[0].number' <<<"$admitted_pulls")"
pr_head_sha="$(jq -r '.[0].head.sha' <<<"$admitted_pulls")"
test "$pr_number" -ge 1
[[ "$pr_head_sha" =~ ^[0-9a-f]{40}$ ]]

git fetch --no-tags origin \
  "refs/pull/${pr_number}/head:refs/remotes/hx-release/pr-${pr_number}-head"
fetched_pr_head="$(git rev-parse "refs/remotes/hx-release/pr-${pr_number}-head")"
test "$fetched_pr_head" = "$pr_head_sha"
engine_tree="$(git rev-parse "${GITHUB_SHA}^{tree}")"
test "$(git rev-parse "${pr_head_sha}^{tree}")" = "$engine_tree"
[[ "$engine_tree" =~ ^[0-9a-f]{40}$ ]]

review_decision="$(gh api graphql \
  -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision}}}' \
  -F owner="$repository_owner" -F name="$repository_name" -F number="$pr_number")"
test "$(jq -r '.data.repository.pullRequest.reviewDecision // ""' <<<"$review_decision")" = "APPROVED"

review_pages="$(gh api --paginate --slurp \
  "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}/reviews?per_page=100")"
independent_review="$(jq -c \
  --argjson reviewer_id "$INDEPENDENT_REVIEWER_ID" \
  '[.[][] | select(.user.id == $reviewer_id)] | sort_by(.id) | last // null' \
  <<<"$review_pages")"
test "$(jq -r '.state // "missing"' <<<"$independent_review")" = "APPROVED"
test "$(jq -r '.commit_id // ""' <<<"$independent_review")" = "$pr_head_sha"
independent_review_id="$(jq -r '.id // 0' <<<"$independent_review")"
test "$independent_review_id" -ge 1

dependency_review_run_id="$(require_check_run \
  "$pr_head_sha" dependency-review '.github/workflows/security.yml' pull_request '')"

status_pages="$(gh api --paginate --slurp \
  "repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/statuses?per_page=100")"
governor_status="$(jq -c \
  '[.[][] | select(.context == "Governor admission")] | sort_by(.id) | last // null' \
  <<<"$status_pages")"
test "$(jq -r '.state // "missing"' <<<"$governor_status")" = "success"
test "$(jq -r '.creator.id // 0' <<<"$governor_status")" = "$GOVERNOR_PUBLISHER_ID"
test "$(jq -r '.creator.type // "missing"' <<<"$governor_status")" = "User"
governor_status_id="$(jq -r '.id // 0' <<<"$governor_status")"
test "$governor_status_id" -ge 1

governor_receipt="$(jq -r '.description // ""' <<<"$governor_status" | \
  sed -nE 's/^governor-control:([0-9a-f]{40}):sha256:([0-9a-f]{64})$/\1 \2/p')"
read -r governor_control_sha governor_receipt_sha256 <<<"$governor_receipt"
[[ "$governor_control_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$governor_receipt_sha256" =~ ^[0-9a-f]{64}$ ]]
expected_governor_target="https://github.com/${GOVERNOR_CONTROL_REPOSITORY}/commit/${governor_control_sha}"
test "$(jq -r '.target_url // ""' <<<"$governor_status")" = "$expected_governor_target"

governor_commit="$(gh api \
  "repos/${GOVERNOR_CONTROL_REPOSITORY}/commits/${governor_control_sha}")"
test "$(jq -r '.sha // ""' <<<"$governor_commit")" = "$governor_control_sha"
test "$(jq -r '.commit.verification.verified // false' <<<"$governor_commit")" = "true"
governor_commit_actor="$(jq -r '.committer.id // .author.id // 0' <<<"$governor_commit")"
test "$governor_commit_actor" = "$GOVERNOR_PUBLISHER_ID"

governor_receipt_path="artifacts/program/release-admissions/${GITHUB_SHA}.json"
receipt_response="$(gh api \
  "repos/${GOVERNOR_CONTROL_REPOSITORY}/contents/${governor_receipt_path}?ref=${governor_control_sha}")"
test "$(jq -r '.type // ""' <<<"$receipt_response")" = "file"
receipt_file="$(mktemp)"
trap 'find "$receipt_file" -depth -delete 2>/dev/null || true' EXIT
receipt_base64="$(jq -r '.content // ""' <<<"$receipt_response" | tr -d '\n')"
test -n "$receipt_base64"
RECEIPT_BASE64="$receipt_base64" node -e \
  'process.stdout.write(Buffer.from(process.env.RECEIPT_BASE64,"base64"))' >"$receipt_file"
test "$(sha256sum "$receipt_file" | awk '{print $1}')" = "$governor_receipt_sha256"
jq -e \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg revision "$GITHUB_SHA" \
  --arg tree "$engine_tree" \
  --arg control "$governor_control_sha" \
  '.schema_version == 1 and
   .kind == "hustlexp_governor_release_admission" and
   .decision == "ACCEPTED" and
   .production_launch_state == "NO-GO" and
   .engine.repository == $repository and
   .engine.revision == $revision and
   .engine.tree == $tree and
   .governor.control_revision == $control and
   .governor.preflight == "PASS" and
   (.governor.evidence_ledger_sha256 | test("^[0-9a-f]{64}$")) and
   .review.state == "ACCEPTED" and
   (.review.builder_actor_id | type == "string" and length > 0) and
   (.review.reviewer_actor_id | type == "string" and length > 0) and
   .review.builder_actor_id != .review.reviewer_actor_id' \
  "$receipt_file" >/dev/null

if [ -n "${HX_ADMISSION_ENV_FILE:-}" ]; then
  {
    echo "HX_ADMISSION_PR_NUMBER=$pr_number"
    echo "HX_ADMISSION_PR_HEAD_SHA=$pr_head_sha"
    echo "HX_ADMISSION_REVIEW_ID=$independent_review_id"
    echo "HX_ADMISSION_CI_RUN_ID=$ci_run_id"
    echo "HX_ADMISSION_SECURITY_RUN_ID=$security_run_id"
    echo "HX_ADMISSION_DEPENDENCY_REVIEW_RUN_ID=$dependency_review_run_id"
    echo "HX_ADMISSION_GOVERNOR_STATUS_ID=$governor_status_id"
    echo "HX_GOVERNOR_CONTROL_SHA=$governor_control_sha"
    echo "HX_GOVERNOR_RECEIPT_PATH=$governor_receipt_path"
    echo "HX_GOVERNOR_RECEIPT_SHA256=$governor_receipt_sha256"
  } >>"$HX_ADMISSION_ENV_FILE"
fi

echo "Release admission verified for ${GITHUB_SHA}"
