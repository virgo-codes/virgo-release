#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly REPOSITORY='virgo-codes/virgo-release'
readonly BUN_VERSION='1.3.14'
readonly BUN_ARCHIVE_SHA='d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620'
readonly BUN_SHA='e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233'
cleanup_dir=''
cleanup() { [[ -z "$cleanup_dir" ]] || rm -rf -- "$cleanup_dir"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { printf '%s\n' "virgo acquisition: $*" >&2; exit 1; }
download() {
  curl -q --fail --location --silent --show-error --proto '=https' --proto-redir '=https' "$1" --output "$2" || fail 'download failed; existing command and installations are preserved. Repeat acquisition to retry.'
}
verify() { [[ "$(shasum -a 256 "$1" | awk '{print $1}')" == "$2" ]] || fail 'checksum verification failed; existing command and installations are preserved. Repeat acquisition to retry.'; }
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'only macOS arm64 is supported.'
[[ "${HOME:-}" == /* ]] || fail 'HOME must be an absolute path.'
for executable in curl unzip shasum plutil; do command -v "$executable" >/dev/null || fail "$executable is unavailable."; done

state_root="$HOME/.local/share/virgo/launcher"
bin_root="$HOME/.local/bin"
mkdir -p "$state_root/packages" "$bin_root"
[[ ! -L "$state_root" && ! -L "$bin_root" ]] || fail 'command/cache directories must not be symbolic links.'
cleanup_dir="$(mktemp -d "$state_root/packages/.acquire.XXXXXX")"
download "https://raw.githubusercontent.com/$REPOSITORY/main/current.json" "$cleanup_dir/current.json"
launcher_sha="$(plutil -extract launcherSha256 raw -o - "$cleanup_dir/current.json")" || fail 'official current metadata does not contain the launcher checksum.'
[[ "$launcher_sha" =~ ^[a-f0-9]{64}$ ]] || fail 'invalid launcher checksum in official metadata.'
download "https://raw.githubusercontent.com/$REPOSITORY/main/launcher.js" "$cleanup_dir/launcher.js"
verify "$cleanup_dir/launcher.js" "$launcher_sha"
download "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-darwin-aarch64.zip" "$cleanup_dir/bun.zip"
verify "$cleanup_dir/bun.zip" "$BUN_ARCHIVE_SHA"
mkdir "$cleanup_dir/bin"
unzip -p "$cleanup_dir/bun.zip" bun-darwin-aarch64/bun > "$cleanup_dir/bin/bun"
verify "$cleanup_dir/bin/bun" "$BUN_SHA"
chmod 700 "$cleanup_dir/bin/bun"
rm "$cleanup_dir/bun.zip"
VIRGO_LAUNCHER_STATE="$state_root" "$cleanup_dir/bin/bun" "$cleanup_dir/launcher.js" --bootstrap-cache "$cleanup_dir/current.json"
# Configure the single owner-home runtime only after every acquisition download passed.
# A matching existing executable is retained in place, preserving supervisor inode pins.
"$cleanup_dir/bin/bun" - "$HOME" "$cleanup_dir/bin/bun" "$BUN_VERSION" "$BUN_SHA" <<'JAVASCRIPT'
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir, lstat, realpath, open, link, unlink } from 'node:fs/promises';
const [home, staged, version, expected] = process.argv.slice(2);
const base = join(home, '.local/share/virgo/bootstrap'), executable = join(base, 'bun', version, 'bin/bun'), path = join(base, 'config.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
async function directory(at) {
  if (dirname(at) !== at) await directory(dirname(at));
  try { await mkdir(at, { mode: 0o700 }); } catch(error) { if(error.code !== 'EEXIST')throw error; }
  const info = await lstat(at);
  if(!info.isDirectory() || info.isSymbolicLink() || await realpath(at)!==at || ((info.mode&0o022)!==0 && !(info.uid===0 && (info.mode&0o1000))))throw new Error('Unsafe bootstrap directory.');
}
async function bytes(at, privateFile = false) {
  const handle = await open(at, constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try { const info = await handle.stat(); if(!info.isFile() || info.uid!==process.getuid() || (privateFile && ((info.mode&0o077)!==0 || info.nlink!==1)) || info.size>(privateFile?8192:128*1024*1024))throw new Error('Unsafe bootstrap file.'); return {info, bytes:await handle.readFile()}; } finally { await handle.close(); }
}
await directory(base);
{
  let oldConfig; try { oldConfig = await bytes(path,true); } catch(error) { if(error.code!=='ENOENT')throw error; }
  let existing; try { existing = await bytes(executable); } catch(error) { if(error.code!=='ENOENT')throw error; }
  if(oldConfig && !existing)throw new Error('Configured runtime is missing; restore it before repeating acquisition.');
  if(existing && (hash(existing.bytes)!==expected || (existing.info.mode&0o022)!==0 || (existing.info.mode&0o111)===0 || await realpath(executable)!==executable))throw new Error('Existing bootstrap Bun differs; no replacement is authorized.');
  if(!existing) {
    await directory(dirname(executable)); const temporary = executable+'.'+randomUUID()+'.acquisition';
    try {
      const verified = await bytes(staged); if(hash(verified.bytes)!==expected)throw new Error('Staged Bun changed.');
      const file = await open(temporary,'wx',0o700); try {await file.writeFile(verified.bytes);await file.sync();}finally{await file.close();}
      try { await link(temporary,executable); } catch(error) {if(error.code!=='EEXIST')throw error;}
    } finally { await unlink(temporary).catch(()=>{}); }
    existing = await bytes(executable);
    if(hash(existing.bytes)!==expected || (existing.info.mode&0o022)!==0 || (existing.info.mode&0o111)===0 || await realpath(executable)!==executable)throw new Error('Concurrent runtime publication differs.');
  }
  const binDirectory = await open(dirname(executable),'r'); try {await binDirectory.sync();}finally{await binDirectory.close();}
  const pin = {schemaVersion:1,bunVersion:version,executable,sha256:expected,identity:identity(existing.info)};
  if(oldConfig) {
    const old = JSON.parse(oldConfig.bytes);
    if(old.schemaVersion!==1 || old.bunVersion!==version || old.executable!==executable || old.sha256!==expected || typeof old.identity!=='string' || !/^\d+:\d+:\d+:\d+(?:\.\d+)?$/u.test(old.identity) || old.identity.slice(old.identity.indexOf(':'))!==pin.identity.slice(pin.identity.indexOf(':')))throw new Error('Bootstrap configuration changed; no repin is authorized.');
  } else {
    const temporary = path+'.'+randomUUID()+'.acquisition'; const file = await open(temporary,'wx',0o600);
    try {
      await file.writeFile(JSON.stringify(pin)+'\n'); await file.sync(); await file.close();
      try {await link(temporary,path);}catch(error){if(error.code!=='EEXIST')throw error;}
      await unlink(temporary);
      const actual=JSON.parse((await bytes(path,true)).bytes);
      if(actual.schemaVersion!==pin.schemaVersion || actual.bunVersion!==pin.bunVersion || actual.executable!==pin.executable || actual.sha256!==pin.sha256 || typeof actual.identity!=='string' || actual.identity.slice(actual.identity.indexOf(':'))!==pin.identity.slice(pin.identity.indexOf(':')))throw new Error('Concurrent bootstrap configuration differs.');
    } finally { await file.close().catch(()=>{}); await unlink(temporary).catch(()=>{}); }
  }
  const parent = await open(base,'r');try {await parent.sync();}finally{await parent.close();}
}
JAVASCRIPT
bootstrap_bun="$HOME/.local/share/virgo/bootstrap/bun/$BUN_VERSION/bin/bun"
# All downloads and pins passed. Publish one immutable package, then atomically
# replace the stable entrypoint. Interrupted setup always leaves the old one usable.
package="$state_root/packages/${cleanup_dir##*/}"
package="${package/.acquire./package-}"
mv "$cleanup_dir" "$package"
cleanup_dir=''
wrapper="$(mktemp "$bin_root/.virgo.XXXXXX")"
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  printf 'package=%q\nstate_root=%q\nbootstrap_bun=%q\n' "$package" "$state_root" "$bootstrap_bun"
  printf '[[ ! -L "$bootstrap_bun" ]] || { echo "virgo: configured runtime is a symlink." >&2; exit 1; }\n'
  printf '[[ "$(shasum -a 256 "$bootstrap_bun" | awk '\''{print $1}'\'')" == %q ]] || { echo "virgo: internal runtime checksum failed; repeat official acquisition." >&2; exit 1; }\n' "$BUN_SHA"
  printf '[[ "$(shasum -a 256 "$package/launcher.js" | awk '\''{print $1}'\'')" == %q ]] || { echo "virgo: launcher checksum failed; repeat official acquisition." >&2; exit 1; }\n' "$launcher_sha"
  printf 'export VIRGO_LAUNCHER_STATE="$state_root"\nexec "$bootstrap_bun" "$package/launcher.js" "$@"\n'
} > "$wrapper"
chmod 700 "$wrapper"
mv -f "$wrapper" "$bin_root/virgo"

case "${SHELL:-/bin/zsh}" in
  */zsh) profile="$HOME/.zprofile" ;;
  */bash) profile="$HOME/.bash_profile" ;;
  *) profile="$HOME/.profile" ;;
esac
[[ ! -L "$profile" ]] || fail 'shell profile is a symbolic link; acquisition preserved it. Use a regular owned shell profile and repeat acquisition.'
# A bounded, idempotent addition preserves every existing profile byte.
path_line='export PATH="$HOME/.local/bin:$PATH" # Virgo public command'
if [[ ! -e "$profile" ]] || ! grep -F -x -- "$path_line" "$profile" >/dev/null 2>&1; then
  profile_temporary="$(mktemp "$HOME/.virgo-profile.XXXXXX")"
  if [[ -f "$profile" ]]; then cat "$profile" > "$profile_temporary"; fi
  printf '\n%s\n' "$path_line" >> "$profile_temporary"
  mv "$profile_temporary" "$profile"
fi
printf '%s\n' 'Virgo command acquired. Open a new terminal, then run:' '  virgo --help' '  virgo install --mode local --machine <machine-id>'
# Retain the former checkout-based invocation for existing callers. Public guides
# acquire first and perform operations with the installed virgo command.
if [[ $# -gt 0 ]]; then
  if [[ "$1" == --* ]]; then set -- install "$@"; fi
  exec "$bin_root/virgo" "$@"
fi
