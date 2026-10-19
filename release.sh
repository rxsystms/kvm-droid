#!/usr/bin/env bash
# Create a draft GitHub release from CI-built installers.
#
# Usage: npm run release -- <X.Y.Z|patch|minor|major> [--dry-run]
#
# Steps: preflight checks -> set package.json/package-lock.json version (commit + push to main
# if changed) -> wait for the CI run on that commit -> tag vX.Y.Z -> download the AppImage, DMG
# and EXE artifacts -> verify they carry the version -> `gh release create --draft`.
# Nothing is published until you review the draft on GitHub and click "Publish release".
set -euo pipefail

WORKFLOW=build-kvm-droid.yml
BRANCH=main
REMOTE=origin

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }
mb() { awk -v b="$1" 'BEGIN { printf "%.0f MB", b / 1048576 }'; }

# Run a silent command (stdout discarded) while showing elapsed time, so long transfers don't look stuck.
with_timer() {
  local label=$1 start=$SECONDS pid status
  shift
  "$@" >/dev/null &
  pid=$!
  if [[ -t 1 ]]; then
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s ... %ds' "$label" $((SECONDS - start))
      sleep 1
    done
    printf '\r\033[K'
  else
    echo "  $label ..."
  fi
  wait "$pid" && status=0 || status=$?
  if (( status )); then
    echo "  $label ... failed"
    return "$status"
  fi
  echo "  $label ... done ($((SECONDS - start))s)"
}

usage() {
  echo "usage: npm run release -- <X.Y.Z|patch|minor|major> [--dry-run]" >&2
  exit 2
}

BUMP=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage ;;
    -*) die "unknown option: $arg" ;;
    *) [[ -z "$BUMP" ]] || usage; BUMP="$arg" ;;
  esac
done
[[ -n "$BUMP" ]] || usage

cd "$(git rev-parse --show-toplevel)"

step "Preflight"
command -v gh >/dev/null || die "GitHub CLI (gh) is required: https://cli.github.com/"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated; run: gh auth login"
[[ "$(git rev-parse --abbrev-ref HEAD)" == "$BRANCH" ]] || die "must be on $BRANCH"
[[ -z "$(git status --porcelain)" ]] || die "working tree is not clean"
git fetch --quiet --tags "$REMOTE" "$BRANCH"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse "$REMOTE/$BRANCH")" ]] ||
  die "local $BRANCH differs from $REMOTE/$BRANCH; pull or push first"

CURRENT=$(node -p "require('./package.json').version")
case "$BUMP" in
  patch|minor|major)
    VERSION=$(node -e '
      const [maj, min, pat] = process.argv[1].split("-")[0].split(".").map(Number);
      const next = { major: [maj + 1, 0, 0], minor: [maj, min + 1, 0], patch: [maj, min, pat + 1] };
      console.log(next[process.argv[2]].join("."));' "$CURRENT" "$BUMP") ;;
  *)
    VERSION="${BUMP#v}"
    [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid version: $BUMP" ;;
esac
TAG="v$VERSION"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists locally"
[[ -z "$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG")" ]] || die "tag $TAG already exists on $REMOTE"
gh release view "$TAG" >/dev/null 2>&1 && die "release $TAG already exists"

echo "package.json: $CURRENT -> release: $VERSION ($TAG)"

step "Tests"
npm test
npm run check

if (( DRY_RUN )); then
  step "Dry run: would now"
  [[ "$VERSION" != "$CURRENT" ]] && echo "  - set version $VERSION, commit 'Release $TAG' and push $BRANCH"
  echo "  - wait for the $WORKFLOW run on that commit to pass"
  echo "  - tag $TAG, push it, download artifacts and create a draft release"
  exit 0
fi

if [[ "$VERSION" != "$CURRENT" ]]; then
  step "Bump version to $VERSION"
  npm version "$VERSION" --no-git-tag-version >/dev/null
  git add package.json package-lock.json
  git commit -m "Release $TAG"
  git push "$REMOTE" "$BRANCH"
fi
SHA=$(git rev-parse HEAD)

step "Waiting for CI on ${SHA:0:7}"
RUN_ID=""
for _ in $(seq 1 30); do
  # Prefer a run that already succeeded; otherwise take the newest branch push run.
  RUN_ID=$(gh run list --workflow "$WORKFLOW" --commit "$SHA" --event push --limit 20 \
    --json databaseId,headBranch,conclusion \
    --jq "[.[] | select(.headBranch == \"$BRANCH\")] | (map(select(.conclusion == \"success\")) + .) | .[0].databaseId // empty")
  [[ -n "$RUN_ID" ]] && break
  sleep 10
done
[[ -n "$RUN_ID" ]] || die "no $WORKFLOW run found for ${SHA:0:7}"
gh run watch "$RUN_ID" --exit-status --interval 30 >/dev/null || die "CI run $RUN_ID failed: $(gh run view "$RUN_ID" --json url -q .url)"
echo "CI run $RUN_ID passed"

step "Tag $TAG"
git tag -a "$TAG" -m "kvm-droid $VERSION" "$SHA"
git push "$REMOTE" "$TAG"

step "Download installers from CI run $RUN_ID"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mapfile -t ARTIFACTS < <(gh api "repos/{owner}/{repo}/actions/runs/$RUN_ID/artifacts" \
  --jq '.artifacts[] | select(.expired | not) | "\(.name)\t\(.size_in_bytes)"')
(( ${#ARTIFACTS[@]} )) || die "run $RUN_ID has no artifacts (expired?)"
TOTAL=0
for entry in "${ARTIFACTS[@]}"; do TOTAL=$((TOTAL + ${entry#*$'\t'})); done
echo "  ${#ARTIFACTS[@]} artifacts, $(mb "$TOTAL") total (zipped)"
i=0
for entry in "${ARTIFACTS[@]}"; do
  i=$((i + 1))
  name=${entry%%$'\t'*}
  with_timer "[$i/${#ARTIFACTS[@]}] $name ($(mb "${entry#*$'\t'}"))" \
    gh run download "$RUN_ID" --name "$name" --dir "$WORK/$name"
done

step "Verify installers"
ASSETS=()
TOTAL=0
for pattern in '*.AppImage' '*.dmg' '*.exe'; do
  mapfile -d '' found < <(find "$WORK" -type f -name "$pattern" -print0)
  (( ${#found[@]} )) || die "no $pattern artifact in run $RUN_ID"
  for file in "${found[@]}"; do
    [[ "$(basename "$file")" == *"$VERSION"* ]] || die "$(basename "$file") does not match version $VERSION"
    size=$(wc -c < "$file" | tr -d ' ')
    TOTAL=$((TOTAL + size))
    echo "  ok  $(basename "$file") ($(mb "$size"))"
    ASSETS+=("$file")
  done
done

step "Creating draft release $TAG..."
with_timer "Uploading ${#ASSETS[@]} installers ($(mb "$TOTAL"))" \
  gh release create "$TAG" "${ASSETS[@]}" --draft --verify-tag --generate-notes --title "kvm-droid $VERSION"
URL=$(gh release view "$TAG" --json url -q .url)
echo
echo "Draft release created: $URL"
echo "Review the notes and assets, then click \"Publish release\"."
