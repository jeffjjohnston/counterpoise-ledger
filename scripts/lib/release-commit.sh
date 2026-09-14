# shellcheck shell=bash
#
# Sourced by scripts/release.sh. Not a program: it defines two functions and
# runs nothing.
#
# release.sh makes the version commit and then pushes the release branch. A run
# that dies in between leaves the bump committed and the tree CLEAN — which is
# exactly what release.sh's own clean-tree guard accepts, so a retry bumped a
# second version for one release.
#
# Recognising that state is the fix, and more than one caller has to recognise
# it identically — the release script decides whether to bump, and the pipeline
# that drives it decides which commit its pre-release checks were meant to
# cover. Two copies of the rule would let them disagree about what HEAD is,
# which is the defect itself, so the rule lives here once.
#
# THE VERSION TAG IS NOT PART OF THIS STATE ANY MORE. Under the merge-release
# flow the tag is published once, after the release PR lands, against the merge
# commit on main — release.sh creates no tag at all. So a tag for the version
# being bumped does not mean "a release is half finished"; it means that
# version IS ALREADY RELEASED, and bumping to it again would give two commits
# one version. That is the `published` state below, and it refuses.

# Prints the version package.json declares, or nothing if it cannot be read.
# Resolved from the repository root rather than $PWD so that both this file's
# caller and its own checks read one package.json: release.sh runs from
# wherever the operator invoked it.
release_declared_version() {
  local root version

  root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$root" ]] || return 0

  version="$(PKG="$root/package.json" node -p "require(process.env.PKG).version" 2>/dev/null || true)"
  [[ "$version" != "undefined" ]] || return 0
  printf '%s' "$version"
}

# Prints what HEAD is, for the version package.json currently declares:
#
#   none         ordinary work; bump normally
#   resume       the unfinished release commit a previous run made; skip the
#                bump and carry on from the push
#   published    a release commit for a version that already carries a tag, so
#                the release it belongs to has already landed. The caller must
#                refuse. The reason is written to stderr.
#
# Two facts identify a release commit, and they come out of the one bump
# release.sh makes: the declared version and the commit subject.
#
# The SUBJECT is what separates a release commit from ordinary work, and it has
# to. main's merge commit for a release also declares the released version in
# package.json, and dev carries that commit after the back-merge — so a test
# that read the version alone would call an ordinary post-release dev "a
# release in progress" and never bump again.
release_head_state() {
  local version subject tagged

  version="$(release_declared_version)"
  if [[ -z "$version" ]]; then
    echo none
    return 0
  fi

  subject="$(git log -1 --pretty=%s 2>/dev/null || true)"
  if [[ "$subject" != "release: v$version" ]]; then
    echo none
    return 0
  fi

  # `refs/tags/...^{commit}` rather than a bare rev-parse: on an ANNOTATED tag
  # a bare rev-parse returns the tag object, and comparing that against a commit
  # answers "different" for a reason that has nothing to do with the release.
  tagged="$(git rev-parse -q --verify "refs/tags/v$version^{commit}" 2>/dev/null || true)"
  if [[ -z "$tagged" ]]; then
    echo resume
    return 0
  fi

  echo published
  cat >&2 <<MSG

HEAD is the release commit for v$version, and tag v$version already exists,
pointing at $tagged.

The tag is published once, against the merge commit on main, after the release
PR lands. Its existence means v$version has already been released, so bumping
from here would give two commits one version number.

Refusing to bump. Resolve which release this checkout belongs to first.

  Already released?    this branch is finished; cut the next release from dev.
  Tag made by hand?    remove it, or bump to a version that has none.
MSG
  return 0
}
