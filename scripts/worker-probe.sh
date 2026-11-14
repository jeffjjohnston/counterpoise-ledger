#!/usr/bin/env bash
# Probes a deployed Worker after `wrangler deploy`, as `docker compose up
# --wait` checks the container: /health answers 200 once the object has
# opened the database, and /api/version names the version that was deployed.
#
#   scripts/worker-probe.sh <base URL> <expected version> [<expected commit>]
#
# Commits between releases share a version, so a deploy also names its
# commit (the Worker's BUILD_COMMIT variable), and /health must carry it in
# x-build-commit before the probe believes the new version answered. The
# Durable Object adds that header, so it names the code that the object
# runs: the front Worker can run the new version before the object does.
#
# A new version takes a few seconds to reach every location, so each check is
# retried for up to two minutes. When ACCESS_CLIENT_ID and
# ACCESS_CLIENT_SECRET are set, each request carries them as a Cloudflare
# Access service token.
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 || -z "$1" || -z "$2" ]]; then
  echo "usage: $0 <base URL> <expected version> [<expected commit>]" >&2
  exit 2
fi
base=${1%/}
expected=$2
commit=${3:-}
attempts=${WORKER_PROBE_ATTEMPTS:-24}
pause=${WORKER_PROBE_PAUSE:-5}

headers=()
if [[ -n "${ACCESS_CLIENT_ID:-}" && -n "${ACCESS_CLIENT_SECRET:-}" ]]; then
  headers=(-H "CF-Access-Client-Id: $ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $ACCESS_CLIENT_SECRET")
fi

get() {
  curl --silent --show-error --max-time 20 ${headers[@]+"${headers[@]}"} "$@"
}

head=$(mktemp)
trap 'rm -f "$head"' EXIT
status=""
build=""
for ((attempt = 1; attempt <= attempts; attempt++)); do
  status=$(get --output /dev/null --dump-header "$head" --write-out '%{http_code}' "$base/health" || true)
  build=$(awk 'tolower($1) == "x-build-commit:" { sub(/\r$/, "", $2); print $2 }' "$head")
  [[ "$status" == 200 && ( -z "$commit" || "$build" == "$commit" ) ]] && break
  sleep "$pause"
done
if [[ "$status" != 200 ]]; then
  echo "The Worker's /health answered ${status:-nothing}, not 200" >&2
  exit 1
fi
if [[ -n "$commit" && "$build" != "$commit" ]]; then
  echo "The Worker's object answers /health from build ${build:-none}, not $commit" >&2
  exit 1
fi
echo "/health answered 200${commit:+ from build $commit}"

version=""
for ((attempt = 1; attempt <= attempts; attempt++)); do
  version=$(get "$base/api/version" | node -e '
    let body = "";
    process.stdin.on("data", (chunk) => (body += chunk));
    process.stdin.on("end", () => {
      try {
        process.stdout.write(String(JSON.parse(body).version ?? ""));
      } catch {
        // Not JSON yet: an old version, or a page in front of the Worker.
      }
    });
  ' || true)
  [[ "$version" == "$expected" ]] && break
  sleep "$pause"
done
if [[ "$version" != "$expected" ]]; then
  echo "The Worker runs version ${version:-unknown}, not $expected" >&2
  exit 1
fi
echo "The Worker runs version $version"
