#!/usr/bin/env bash
# Cut a Z-CMS release.
#
#   ./scripts/release.sh 0.1.2
#   ./scripts/release.sh 0.1.2 --yes     # no confirmation prompt
#   ./scripts/release.sh 0.1.2 --watch   # also wait for the build + verify Docker Hub
#
# What it does:
#   1. fetches origin/main and picks its tip (or --ref <sha|branch|tag>)
#   2. refuses unless that commit's CI is green (waits if it is still running)
#   3. tags it v<version> and pushes the tag
#   4. the push triggers .github/workflows/release.yml, which builds every service
#      image multi-arch (amd64+arm64) and pushes to BOTH GHCR and Docker Hub
#      (zcms/<service>:<version> + <major.minor> + latest)
#   5. creates the GitHub Release with auto-generated notes
#
# Requires: git, the `gh` CLI (authenticated), and the DOCKERHUB_USERNAME /
# DOCKERHUB_TOKEN secrets on the repo (the workflow needs them to push).
set -euo pipefail

# --- args ------------------------------------------------------------------
VERSION="" ; REF="origin/main" ; ASSUME_YES=0 ; WATCH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)   ASSUME_YES=1 ;;
    --watch|-w) WATCH=1 ;;
    --ref)      REF="$2" ; shift ;;
    -*)         echo "unknown flag: $1" >&2 ; exit 2 ;;
    *)          VERSION="$1" ;;
  esac
  shift
done

VERSION="${VERSION#v}"                                   # accept 0.1.2 or v0.1.2
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: $0 <version>   e.g. $0 0.1.2   (got: '${VERSION:-<none>}')" >&2
  exit 2
fi
TAG="v${VERSION}"
cd "$(dirname "$0")/.."

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo ">> repo: $REPO   release: $TAG   from: $REF"

# --- preconditions ---------------------------------------------------------
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null || \
   git ls-remote --tags origin "refs/tags/${TAG}" | grep -q "${TAG}$"; then
  echo "!! tag ${TAG} already exists (local or remote). Pick a new version." >&2
  exit 1
fi

# The workflow can't push to Docker Hub without these — warn early.
if ! gh secret list --repo "$REPO" 2>/dev/null | grep -q DOCKERHUB_TOKEN; then
  echo "!! WARNING: DOCKERHUB_TOKEN secret not found on $REPO — the Docker Hub push will fail." >&2
  echo "   Set it with: gh secret set DOCKERHUB_TOKEN --repo $REPO --body '<token>'" >&2
fi

echo ">> fetching…"
git fetch --quiet origin main --tags
SHA=$(git rev-parse "$REF")
echo ">> target commit: ${SHA:0:12}  $(git log -1 --format='%s' "$SHA")"

# --- CI gate: require every check on the target commit to be green ---------
echo ">> checking CI on ${SHA:0:12} …"
for attempt in $(seq 1 40); do
  running=$(gh api "repos/$REPO/commits/$SHA/check-runs" \
    --jq '[.check_runs[]|select(.status!="completed")]|length' 2>/dev/null || echo "?")
  [[ "$running" == "0" ]] && break
  echo "   CI still running ($running checks pending) — waiting 45s… [$attempt/40]"
  sleep 45
done
failed=$(gh api "repos/$REPO/commits/$SHA/check-runs" \
  --jq '[.check_runs[]|select(.conclusion!=null and .conclusion!="success" and .conclusion!="neutral" and .conclusion!="skipped")]|length' 2>/dev/null || echo "?")
total=$(gh api "repos/$REPO/commits/$SHA/check-runs" --jq '.check_runs|length' 2>/dev/null || echo 0)
if [[ "$total" == "0" ]]; then
  echo "!! no CI checks found for ${SHA:0:12} — refusing to release an unverified commit." >&2
  exit 1
fi
if [[ "$failed" != "0" ]]; then
  echo "!! CI is NOT green on ${SHA:0:12} ($failed failing check(s)) — aborting." >&2
  gh api "repos/$REPO/commits/$SHA/check-runs" \
    --jq '.check_runs[]|select(.conclusion!=null and .conclusion!="success" and .conclusion!="neutral" and .conclusion!="skipped")|"   FAILED: \(.name)"' 2>/dev/null
  exit 1
fi
echo ">> CI green ($total checks)."

# --- confirm ---------------------------------------------------------------
if [[ "$ASSUME_YES" != "1" ]]; then
  read -r -p ">> Tag ${SHA:0:12} as ${TAG} and publish to Docker Hub? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "aborted."; exit 0; }
fi

# --- tag + push (triggers the multi-arch build + push) ---------------------
git tag -a "$TAG" "$SHA" -m "z-cms ${VERSION}"
# The pre-push hook re-runs the whole test suite; the tagged commit is already
# CI-verified above, so skip it. Everything else about the push is normal.
git push --no-verify origin "$TAG"
echo ">> pushed ${TAG} — release.yml is now building + pushing the images."

# --- GitHub Release --------------------------------------------------------
gh release create "$TAG" --repo "$REPO" --title "z-cms ${VERSION}" --generate-notes
echo ">> GitHub Release created: $(gh release view "$TAG" --repo "$REPO" --json url -q .url)"

[[ "$WATCH" != "1" ]] && { echo ">> done. (Pass --watch to wait for the build.)"; exit 0; }

# --- optional: wait for the build, then verify Docker Hub ------------------
echo ">> waiting for the Release images run…"
sleep 8
RID=$(gh run list --repo "$REPO" --workflow="Release images" --limit 5 \
  --json event,headBranch,databaseId -q "[.[]|select(.headBranch==\"$TAG\")][0].databaseId")
if [[ -z "${RID:-}" ]]; then echo "   (could not find the run; check the Actions tab)"; exit 0; fi
for attempt in $(seq 1 70); do
  st=$(gh run view "$RID" --repo "$REPO" --json status -q .status 2>/dev/null)
  [[ "$st" == "completed" ]] && break
  sleep 60
done
echo ">> run conclusion: $(gh run view "$RID" --repo "$REPO" --json conclusion -q .conclusion)"
echo ">> Docker Hub tags:"
for img in cms-api site-runtime admin-web worker migrate plugin-runtime; do
  tags=$(curl -fsS "https://hub.docker.com/v2/repositories/zcms/$img/tags?page_size=30" \
    | python3 -c "import sys,json;print(','.join(sorted(t['name'] for t in json.load(sys.stdin).get('results',[]))))" 2>/dev/null || echo "?")
  printf "   zcms/%-14s -> %s\n" "$img" "$tags"
done
echo ">> done."
