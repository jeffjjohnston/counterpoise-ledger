#!/bin/sh
# Refuses a Compose or deploy run whose working directory is not the checkout
# root.
#
# docker-compose.yml pins the project name to `counterpoise`, so Compose
# addresses the SAME production containers from every directory, and it
# searches UPWARD for a compose file, so a subdirectory still finds it.
#
# WHAT THAT COSTS: --env-file IS RESOLVED AGAINST THE WORKING DIRECTORY.
#
# Verified: the same `--env-file .env` reads a different file from each
# directory it is run in. A run from the wrong place therefore interpolates
# TZ, APP_BIND and COUNTERPOISE_BACKUPS_DIR from the wrong file,
# while the containers being recreated are production's. A file that is simply
# ABSENT is not the danger: Compose exits 1 with "couldn't find env file".
# The danger is a file that exists and says something else.
#
# WHAT IS NOT THE HAZARD, though this comment claimed it for a long time:
# relative bind mounts and service-level `env_file:` entries resolve against
# the COMPOSE FILE's directory, not the working directory — verified from a
# subdirectory and from an unrelated path, both resolving to the compose
# file's own directory. The service env files are also `required: true`, so a
# missing one is an error rather than a silent skip.
#
# WHY A SEPARATE SCRIPT
#
# One question, one refusal, exit 1, and a message that names the remedy. A
# guard in the app container cannot see the host working directory, so this
# question needs its own guard on the host. scripts/deploy.sh runs it before it reads
# anything else, and an operator can run it by hand before a manual
# `docker compose` command.
#
# WHAT IT CANNOT DO. It cannot reach a bare `docker compose up` typed in a
# terminal. Nothing in this repository can. It closes the path this repository
# owns and makes the rule explicit for the path it does not.

set -e

# An operator's CDPATH must not reach the `cd` below. `cd` searches CDPATH
# before the current directory, so a `cd` meant to reach one directory can land
# in another, and this guard would then compare the wrong pair.
CDPATH=

# -P, because the comparison below is between directories and not between
# spellings. /tmp and /private/tmp name one directory on macOS, and an
# unresolved pair of them is unequal.
cwd=$(pwd -P)

# THE MAIN WORKING TREE, which is what `--git-common-dir` answers from inside a
# linked worktree; `--show-toplevel` answers with the worktree itself and would
# report agreement with itself. It also answers from a husk, because git walks
# up until it finds a repository — which is how a removed worktree's path still
# resolves to the checkout that holds the compose file.
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || common_dir=""
if [ -n "$common_dir" ]; then
  # `dirname` of a relative `.git` is `.`, which is this directory — the answer
  # git gives when the working directory already IS the main working tree.
  root=$(cd "$(dirname "$common_dir")" 2>/dev/null && pwd -P) || root=""
else
  root=""
fi

if [ "$cwd" != "$root" ]; then
  echo "FATAL: Compose must run in the checkout root, and this is not it." >&2
  echo "" >&2
  echo "  working directory: $cwd" >&2
  if [ -n "$root" ]; then
    echo "  checkout root:     $root" >&2
  else
    echo "  checkout root:     unknown — this directory is in no git checkout" >&2
  fi
  echo "" >&2
  echo "docker-compose.yml pins the project name, so Compose addresses the" >&2
  echo "production containers from here. --env-file is resolved against THIS" >&2
  echo "directory, so a wrong one here recreates production while reading its" >&2
  echo "settings from the wrong file." >&2
  echo "" >&2
  echo "Change to the checkout root and run the command again." >&2
  exit 1
fi

# THE COMPOSE FILE HAS TO BE THE ONE IN THIS DIRECTORY. Without this the guard
# permits the root of ANY git checkout, and "this is a checkout root" is not
# the question. Compose searches upward when this directory holds no file, so
# an absent file is the same hijack one directory higher.
if [ ! -f "$cwd/docker-compose.yml" ]; then
  echo "FATAL: no docker-compose.yml in the working directory." >&2
  echo "" >&2
  echo "  working directory: $cwd" >&2
  echo "" >&2
  echo "Compose searches upward when it finds no file here, so it would use" >&2
  echo "another directory's compose file and address the project that file" >&2
  echo "names. Change to the Counterpoise checkout root and run the command" >&2
  echo "again." >&2
  exit 1
fi
