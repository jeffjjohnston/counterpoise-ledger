#!/usr/bin/env bash
# Runs wrangler at the version this repository pins, from npx, so no package
# in the lockfile carries it. Every wrangler call in CI, the deploy workflow,
# the npm scripts and the Worker test helper goes through here.
#
# .npmrc sets strict-allow-scripts, so npm skips any install script that
# allowScripts in package.json does not name, and that map covers the
# lockfile, not npx's own install, which a flag also turns off. wrangler's
# esbuild and workerd fetch their platform binaries in postinstall scripts,
# and on macOS its optional fsevents builds in an install script, so this
# approves those three, by name, for this one install. wrangler pins esbuild
# and workerd at exact versions; fsevents installs only on macOS.
set -euo pipefail

exec npx --yes --allow-scripts=esbuild,workerd,fsevents wrangler@4.151.0 "$@"
