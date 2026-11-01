# shellcheck shell=bash
#
# Sourced by scripts/deploy.sh, and by a script that calls deploy.sh and must
# know the target first. Not a program: it defines two functions and runs
# nothing.
#
# THE DEPLOY TARGET. COUNTERPOISE_DEPLOY_TARGET says where production runs:
#
#   docker   the default. deploy.sh fast-forwards the production checkout and
#            runs `docker compose up`. An install on its own machine uses
#            this target.
#   worker   production is the Cloudflare Worker. deploy.sh publishes the tag
#            and waits for the worker-deploy.yml run that the tag starts. It
#            does not touch the production checkout or Docker.
#
# Each script that asks must get the same answer. If a caller thinks "worker"
# and deploy.sh thinks "docker", deploy.sh starts the old container next to
# the Worker, and there are two live databases. So the rule is here, one time.

# Prints the value of one key from the gitignored .env.deploy.local at the
# checkout root <root>. Returns 1 when the file or the key is not there.
#
# The file is not sourced. Only the line for <key> is read, so another line in
# the file cannot run code or change another setting. The last line for the
# key wins. Spaces around the value and one pair of quotes are removed.
deploy_local_value() {
  local file="$1/.env.deploy.local" key="$2" line value="" found=1
  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*${key}=(.*)$ ]] || continue
    found=0
    value="${BASH_REMATCH[1]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
  done <"$file"
  [[ $found == 0 ]] || return 1
  printf '%s\n' "$value"
}

# Prints the deploy target, "docker" or "worker", for the checkout root
# <root>. The environment variable wins. If it is empty, the key in
# .env.deploy.local is used. If neither gives a value, the target is "docker".
# Any other value is an error: a misspelt "worker" must not deploy to Docker.
deploy_target() {
  local root="$1" target="" source=""
  if [[ -n "${COUNTERPOISE_DEPLOY_TARGET:-}" ]]; then
    target="$COUNTERPOISE_DEPLOY_TARGET"
    source="the COUNTERPOISE_DEPLOY_TARGET environment variable"
  elif target="$(deploy_local_value "$root" COUNTERPOISE_DEPLOY_TARGET)" && [[ -n "$target" ]]; then
    source="$root/.env.deploy.local"
  else
    target=docker
    source="the built-in default"
  fi
  case "$target" in
    docker | worker) printf '%s\n' "$target" ;;
    *)
      echo "Error: the deploy target '$target' from $source is not valid. Use docker or worker." >&2
      return 1
      ;;
  esac
}
