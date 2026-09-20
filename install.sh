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
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || fail "only macOS arm64 is supported."
command -v bun >/dev/null 2>&1 || fail "Bun must be installed."
command -v gh >/dev/null 2>&1 || fail "GitHub CLI must be installed."
gh auth status >/dev/null 2>&1 || fail "GitHub CLI must be authenticated."

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
metadata="$script_dir/current.json"
[[ -f "$metadata" ]] || fail "current.json is missing."
current="$(bun -e '
const value=JSON.parse(await Bun.file(process.argv[1]).text());
if(typeof value.release!=="string"||!/^[a-f0-9]{64}$/.test(value.release)||typeof value.cliSha256!=="string"||!/^[a-f0-9]{64}$/.test(value.cliSha256))process.exit(2);
console.log(value.release); console.log(value.cliSha256);
' "$metadata")" || fail "current.json does not name an exact release and SHA-256."
release="${current%%$'\n'*}"
expected_sha="${current#*$'\n'}"

has_machine=false
for argument in "$@"; do [[ "$argument" == "--machine" ]] && has_machine=true; done
$has_machine || fail "--machine is required."

cleanup_dir="$(mktemp -d "${TMPDIR:-/tmp}/virgo-release.XXXXXX")"
gh release download "$release" --repo "$REPOSITORY" --pattern "$ASSET" --dir "$cleanup_dir"
asset="$cleanup_dir/$ASSET"
[[ -f "$asset" ]] || fail "release asset was not downloaded."
actual_sha="$(shasum -a 256 "$asset" | awk '{print $1}')"
[[ "$actual_sha" == "$expected_sha" ]] || fail "release asset checksum does not match current.json."
chmod 700 "$asset"

"$asset" install --mode local --release "$release" --github-repository "$REPOSITORY" "$@"
