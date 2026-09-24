#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY="virgo-codes/virgo-release"
readonly ASSET="virgo-macos-arm64"
cleanup_dir=""
cleanup() { [[ -z "$cleanup_dir" ]] || rm -rf -- "$cleanup_dir"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { printf '%s\n' "virgo-release: $*" >&2; exit 1; }

# Validate before authentication/downloads. The wrapper owns command, mode and
# artifact selection; every forwarded value remains one quoted array item.
operation="install"
mode="local"
if [[ $# -gt 0 && "$1" != --* ]]; then
  case "$1" in
    install|upgrade|rollback) operation="$1"; shift ;;
    *) fail "expected install, upgrade, rollback, or legacy install flags." ;;
  esac
fi
seen_flags=" "
forwarded=()
has_machine=false
has_plan=false
while [[ $# -gt 0 ]]; do
  flag="$1"
  case "$flag" in
    --release|--release=*|--github-repository|--github-repository=*|--manifest-directory|--manifest-directory=*|--bundle|--bundle=*)
      fail "caller-supplied release/distribution options cannot override current.json." ;;
  esac
  [[ "$flag" =~ ^--[a-z][a-z0-9-]*$ ]] || fail "options must use --name value pairs."
  [[ "$seen_flags" != *" $flag "* ]] || fail "duplicate option: $flag."
  [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "$flag requires a value."
  [[ ! "$2" =~ [[:cntrl:]] ]] || fail "$flag cannot contain control characters."
  seen_flags+="$flag "
  if [[ "$operation" != "install" ]]; then
    case "$flag" in
      --mode|--machine|--root|--instance|--plan-id) ;;
      *) fail "$operation accepts only --mode, --machine, --root, --instance and rollback's --plan-id." ;;
    esac
  fi
  case "$flag" in
    --mode) mode="$2" ;;
    --root) [[ "$2" == /* ]] || fail "--root must be an absolute path."; forwarded+=("$flag" "$2") ;;
    --machine) has_machine=true; forwarded+=("$flag" "$2") ;;
    --plan-id) has_plan=true; forwarded+=("$flag" "$2") ;;
    *) forwarded+=("$flag" "$2") ;;
  esac
  shift 2
done
case "$mode" in local|host) ;; *) fail "--mode must be local or host." ;; esac
$has_machine || fail "--machine is required."
[[ "$operation" == "install" || "$mode" == "host" ]] || fail "$operation requires --mode host."
if [[ "$operation" == "rollback" ]]; then
  $has_plan || fail "rollback requires --plan-id from the prior successful upgrade."
else
  ! $has_plan || fail "--plan-id is only supported for rollback."
fi

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || fail "only macOS arm64 is supported."
command -v bun >/dev/null 2>&1 || fail "Bun must be installed."
command -v gh >/dev/null 2>&1 || fail "GitHub CLI must be installed."

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
metadata="$script_dir/current.json"
[[ -f "$metadata" ]] || fail "current.json is missing."
current="$(bun -e '
const value=JSON.parse(await Bun.file(process.argv[1]).text());
if(!value||typeof value!=="object"||Array.isArray(value)||value.sourceRepository!=="virgo-codes/virgo"||value.platform?.os!=="macos"||value.platform?.architecture!=="arm64"||typeof value.release!=="string"||!/^[a-f0-9]{64}$/.test(value.release)||typeof value.cliSha256!=="string"||!/^[a-f0-9]{64}$/.test(value.cliSha256))process.exit(2);
console.log(value.release); console.log(value.cliSha256);
' "$metadata")" || fail "current.json does not name an exact release and SHA-256."
release="${current%%$'\n'*}"
expected_sha="${current#*$'\n'}"

gh auth status >/dev/null 2>&1 || fail "GitHub CLI must be authenticated."

cleanup_dir="$(mktemp -d "${TMPDIR:-/tmp}/virgo-release.XXXXXX")"
gh release download "release-$release" --repo "$REPOSITORY" --pattern "$ASSET" --dir "$cleanup_dir"
asset="$cleanup_dir/$ASSET"
[[ -f "$asset" ]] || fail "release asset was not downloaded."
actual_sha="$(shasum -a 256 "$asset" | awk '{print $1}')"
[[ "$actual_sha" == "$expected_sha" ]] || fail "release asset checksum does not match current.json."
if [[ "$operation" == "rollback" ]]; then
  # The verified CLI resolves the prior artifact from the installed plan/cache.
  bun "$asset" rollback --mode host "${forwarded[@]}"
else
  bun "$asset" "$operation" --mode "$mode" --release "$release" --github-repository "$REPOSITORY" "${forwarded[@]}"
fi
