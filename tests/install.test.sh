#!/usr/bin/env bash
set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/virgo-bootstrap-tests.XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
export VIRGO_BOOTSTRAP_TEST_BUN="$(command -v bun)"
fixture="$test_root/bootstrap path with spaces"
mkdir -p "$fixture" "$test_root/fake bin" "$test_root/downloads with spaces"
cp "$repository/install.sh" "$fixture/install.sh"
export TMPDIR="$test_root/downloads with spaces"
export VIRGO_BOOTSTRAP_TEST_GH_LOG="$test_root/gh.jsonl"
export VIRGO_BOOTSTRAP_TEST_DISPATCH="$test_root/dispatched.json"
export VIRGO_BOOTSTRAP_TEST_ASSET="$test_root/fixture asset"
export VIRGO_BOOTSTRAP_TEST_BEHAVIOR="ok"
export VIRGO_BOOTSTRAP_TEST_EXIT_CODE="0"

# Deliberately neither executable nor a valid OS shebang: only an explicit Bun
# interpreter can run the verified fixture. It performs no installation work.
cat > "$VIRGO_BOOTSTRAP_TEST_ASSET" <<'ASSET'
#!/nonexistent/interpreter
await Bun.write(process.env.VIRGO_BOOTSTRAP_TEST_DISPATCH, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.VIRGO_BOOTSTRAP_TEST_EXIT_CODE));
ASSET
chmod 600 "$VIRGO_BOOTSTRAP_TEST_ASSET"
cat > "$test_root/fake bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
"$VIRGO_BOOTSTRAP_TEST_BUN" -e 'require("node:fs").appendFileSync(process.env.VIRGO_BOOTSTRAP_TEST_GH_LOG, JSON.stringify(process.argv.slice(1))+"\n");' "$@"
if [[ "$1 $2" == "auth status" ]]; then
  [[ "$VIRGO_BOOTSTRAP_TEST_BEHAVIOR" != "auth-fail" ]]
  exit
fi
[[ "$1 $2" == "release download" ]] || exit 91
[[ "$VIRGO_BOOTSTRAP_TEST_BEHAVIOR" != "download-fail" ]] || exit 23
shift 3
destination=""
while [[ $# -gt 0 ]]; do
  case "$1" in --dir) destination="$2" ;; --repo|--pattern) ;; *) exit 92 ;; esac
  shift 2
done
[[ -n "$destination" ]] || exit 93
cp "$VIRGO_BOOTSTRAP_TEST_ASSET" "$destination/virgo-macos-arm64"
if [[ "$VIRGO_BOOTSTRAP_TEST_BEHAVIOR" == "tamper" ]]; then
  printf '%s\n' '// changed after metadata was pinned' >> "$destination/virgo-macos-arm64"
fi
GH
cat > "$test_root/fake bin/uname" <<'UNAME'
#!/usr/bin/env bash
case "$1" in -s) printf 'Darwin\n' ;; -m) printf 'arm64\n' ;; *) exit 94 ;; esac
UNAME
chmod 700 "$test_root/fake bin/gh" "$test_root/fake bin/uname"
export PATH="$test_root/fake bin:$PATH"

"$VIRGO_BOOTSTRAP_TEST_BUN" -e '
const value=await Bun.file(process.argv[1]).json();
value.cliSha256=require("node:crypto").createHash("sha256").update(Buffer.from(await Bun.file(process.env.VIRGO_BOOTSTRAP_TEST_ASSET).arrayBuffer())).digest("hex");
await Bun.write(process.argv[2],JSON.stringify(value));
' "$repository/current.json" "$test_root/valid-current.json"
release="$("$VIRGO_BOOTSTRAP_TEST_BUN" -e 'console.log((await Bun.file(process.argv[1]).json()).release)' "$test_root/valid-current.json")"
passed=0
reset_case() {
  cp "$test_root/valid-current.json" "$fixture/current.json"
  rm -f "$VIRGO_BOOTSTRAP_TEST_GH_LOG" "$VIRGO_BOOTSTRAP_TEST_DISPATCH"
  export VIRGO_BOOTSTRAP_TEST_BEHAVIOR="ok" VIRGO_BOOTSTRAP_TEST_EXIT_CODE="0"
}
run() { (cd "$fixture"; bash "$fixture/install.sh" "$@") > "$test_root/stdout" 2> "$test_root/stderr"; }
pass() { passed=$((passed + 1)); }
assert_dispatch() {
  "$VIRGO_BOOTSTRAP_TEST_BUN" -e '
const actual=await Bun.file(process.env.VIRGO_BOOTSTRAP_TEST_DISPATCH).json();
const expected=process.argv.slice(1);
if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(JSON.stringify({actual,expected}));
' "$@"
}
assert_download() {
  "$VIRGO_BOOTSTRAP_TEST_BUN" -e '
const calls=(await Bun.file(process.env.VIRGO_BOOTSTRAP_TEST_GH_LOG).text()).trim().split("\n").map(x=>JSON.parse(x));
if(JSON.stringify(calls[0])!==JSON.stringify(["auth","status"])||calls.length!==2)throw new Error("Expected only authentication and one download");
const args=calls[1];const expected=["release","download","release-"+process.argv[1],"--repo","virgo-codes/virgo-release","--pattern","virgo-macos-arm64","--dir"];
if(JSON.stringify(args.slice(0,8))!==JSON.stringify(expected)||args.length!==9)throw new Error("Unpinned download arguments");
if(require("node:fs").existsSync(args[8]))throw new Error("Temporary download was not cleaned");
' "$release"
}
reject_before_download() {
  reset_case
  if run "$@"; then printf 'Unexpected acceptance: %s\n' "$*" >&2; exit 1; fi
  [[ ! -e "$VIRGO_BOOTSTRAP_TEST_GH_LOG" && ! -e "$VIRGO_BOOTSTRAP_TEST_DISPATCH" ]]
  pass
}

reset_case
run --machine legacy --root "$test_root/local root" --postgres-port 55432
assert_dispatch install --mode local --release "$release" --github-repository virgo-codes/virgo-release --machine legacy --root "$test_root/local root" --postgres-port 55432
assert_download; pass

reset_case
run install --mode local --machine explicit
assert_dispatch install --mode local --release "$release" --github-repository virgo-codes/virgo-release --machine explicit
assert_download; pass

reset_case
quoted_root="$test_root/"'root $(touch never-run) `quoted` *'
run install --machine remote --mode host --root "$quoted_root" --hub-url https://hub.example/ --account account --network tailscale --advertised-url https://host.example/ --enrollment-credential-file "$test_root/private credential path"
assert_dispatch install --mode host --release "$release" --github-repository virgo-codes/virgo-release --machine remote --root "$quoted_root" --hub-url https://hub.example/ --account account --network tailscale --advertised-url https://host.example/ --enrollment-credential-file "$test_root/private credential path"
[[ ! -e "$quoted_root" && ! -e "$fixture/never-run" ]]; assert_download; pass

reset_case
run upgrade --mode host --machine remote --root "$quoted_root" --instance second
assert_dispatch upgrade --mode host --release "$release" --github-repository virgo-codes/virgo-release --machine remote --root "$quoted_root" --instance second
assert_download; pass

reset_case
run upgrade --mode local --machine hub
assert_dispatch upgrade --mode local --release "$release" --github-repository virgo-codes/virgo-release --machine hub
assert_download; pass

reset_case
run upgrade --mode local --machine hub --root "$quoted_root" --instance custom-hub
assert_dispatch upgrade --mode local --release "$release" --github-repository virgo-codes/virgo-release --machine hub --root "$quoted_root" --instance custom-hub
assert_download; pass

reset_case
run rollback --mode host --machine remote --plan-id plan-123 --instance second --root "$quoted_root"
assert_dispatch rollback --mode host --machine remote --plan-id plan-123 --instance second --root "$quoted_root"
assert_download; pass

# Every pin option, spelling and dispatch path refuses caller-selected artifacts.
for operation in install upgrade rollback; do
  for flag in --release --github-repository --manifest-directory --bundle; do
    reject_before_download "$operation" --mode host --machine remote "$flag" override
    reject_before_download "$operation" --mode host --machine remote "$flag=override"
  done
done
reject_before_download
reject_before_download --machine
reject_before_download --machine ""
reject_before_download --machine first --machine second
reject_before_download install --mode host --mode local --machine remote
reject_before_download install --mode=host --machine remote
reject_before_download install --mode unsupported --machine remote
reject_before_download install --machine remote --root relative
reject_before_download install --machine remote --root /one --root /two
reject_before_download install --machine remote --root
reject_before_download install --machine remote --account $'line\nbreak'
reject_before_download install --machine remote -- --release override
reject_before_download install --machine remote extra-token
reject_before_download upgrade --machine remote
reject_before_download upgrade --mode host --machine remote --account account
reject_before_download rollback --mode host --machine remote
reject_before_download rollback --mode local --machine hub --plan-id plan-123
reject_before_download rollback --mode host --machine remote --plan-id first --plan-id second
reject_before_download install --machine remote --plan-id unexpected
reject_before_download upgrade --mode host --machine remote --plan-id unexpected
reject_before_download unknown --machine remote

for malformed in 'null' '{"release":"not-an-id"}' '{not-json'; do
  reset_case
  printf '%s\n' "$malformed" > "$fixture/current.json"
  if run --machine legacy; then exit 1; fi
  [[ ! -e "$VIRGO_BOOTSTRAP_TEST_GH_LOG" && ! -e "$VIRGO_BOOTSTRAP_TEST_DISPATCH" ]]; pass
done
reset_case
export VIRGO_BOOTSTRAP_TEST_BEHAVIOR=tamper
if run install --mode host --machine remote; then exit 1; fi
[[ ! -e "$VIRGO_BOOTSTRAP_TEST_DISPATCH" ]]; assert_download; pass

reset_case
export VIRGO_BOOTSTRAP_TEST_BEHAVIOR=auth-fail
if run --machine legacy; then exit 1; fi
[[ ! -e "$VIRGO_BOOTSTRAP_TEST_DISPATCH" ]]
[[ "$(wc -l < "$VIRGO_BOOTSTRAP_TEST_GH_LOG" | tr -d ' ')" == 1 ]]; pass

reset_case
export VIRGO_BOOTSTRAP_TEST_BEHAVIOR=download-fail
if run --machine legacy; then exit 1; fi
[[ ! -e "$VIRGO_BOOTSTRAP_TEST_DISPATCH" ]]; assert_download; pass

reset_case
export VIRGO_BOOTSTRAP_TEST_EXIT_CODE=7
status=0
run upgrade --mode host --machine remote || status=$?
[[ "$status" == 7 ]]; assert_download; pass

printf 'PASS: %s isolated shell cases (real Bash/Bun, fake gh/asset, no live effects).\n' "$passed"
