#!/usr/bin/env bash
set -euo pipefail

# Publishes the version tag of a release commit on main. The workflow
# .github/workflows/worker-release.yml runs it when main moves, and deploys
# the commit when it prints deploy=true.
#
# Usage: scripts/release-tag.sh <commit>
#
# It reads the version from package.json at <commit>, and compares it with
# the version at the first parent (main before the merge):
#
#   version not changed  not a release: a change to main that is not a
#                        release merge. Change nothing. deploy=false
#   tag absent           create vX.Y.Z, annotated, at <commit>, and push it
#                        without --force. deploy=true
#   tag at <commit>      a re-run of the workflow. Change nothing. deploy=true
#   tag elsewhere        this version was released at another commit. Refuse
#                        (exit 1): a tag is published once and never moved,
#                        as in deploy.sh
#
# The result goes to stdout, and to $GITHUB_OUTPUT when it is set.

die() { echo "release-tag: $*" >&2; exit 1; }

[[ $# -eq 1 ]] || die "usage: $0 <commit>"

SHA=$(git rev-parse --verify --quiet "$1^{commit}") \
  || die "'$1' does not resolve to a commit"

git fetch --quiet origin main

# Only a commit that main holds is a release. A tag on any other commit would
# name code that no release PR landed.
git merge-base --is-ancestor "$SHA" origin/main \
  || die "${SHA:0:7} is not on origin/main"

# Prints the version at <commit>, or nothing. `|| true`: under pipefail, a
# commit with no package.json would otherwise stop the script with no message.
version_at() {
  git show "$1:package.json" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version||""))}catch{}})' \
    || true
}

result() {
  echo "deploy=$1"
  echo "tag=$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    { echo "deploy=$1"; echo "tag=$2"; } >>"$GITHUB_OUTPUT"
  fi
}

VERSION=$(version_at "$SHA")
[[ -n "$VERSION" ]] || die "${SHA:0:7} declares no version in package.json"
TAG="v$VERSION"

PARENT_VERSION=""
if git rev-parse --verify --quiet "$SHA^1" >/dev/null; then
  PARENT_VERSION=$(version_at "$SHA^1")
fi
if [[ "$PARENT_VERSION" == "$VERSION" ]]; then
  echo "${SHA:0:7} does not change the version ($VERSION), so it is not a release. Nothing to deploy."
  result false "$TAG"
  exit 0
fi

# Peeled: on an annotated tag, the `^{}` line names the commit. A lightweight
# tag has only the bare line. Both patterns are passed, because ls-remote
# does not advertise the peeled line unless it is asked for.
LINES=$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}") \
  || die "cannot read the tags of origin"
REMOTE_AT=$(printf '%s\n' "$LINES" | awk '$2 ~ /\^\{\}$/ {print $1}' | tail -1)
[[ -n "$REMOTE_AT" ]] || REMOTE_AT=$(printf '%s\n' "$LINES" | awk 'NF {print $1}' | tail -1)

if [[ -z "$REMOTE_AT" ]]; then
  echo "Tagging $TAG at ${SHA:0:7}..."
  # -f only replaces a local tag of this runner, which a fresh checkout does
  # not have. The push has no --force: if origin got the tag in the meantime,
  # the push fails, and the next run reads it.
  git tag -f -a "$TAG" "$SHA" -m "release: $TAG" >/dev/null
  git push --quiet origin "refs/tags/$TAG"
elif [[ "$REMOTE_AT" == "$SHA" ]]; then
  echo "Tag $TAG is already published at ${SHA:0:7}."
else
  die "tag $TAG already points at ${REMOTE_AT:0:7}, not at ${SHA:0:7}. A tag is published once and never moved, so $VERSION was released at another commit. Bump the version in a new release"
fi

result true "$TAG"
