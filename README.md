# Virgo public command

This repository publishes Virgo's official acquisition script and stable `virgo`
command for macOS Apple Silicon. The command selects a checksum-verified release
CLI and delegates installation and runtime operations to that existing CLI.

Acquire the command once:

```sh
curl --fail --location --proto '=https' --proto-redir '=https' \
  https://raw.githubusercontent.com/virgo-codes/virgo-release/main/install.sh | bash
```

Open a new terminal, then use `virgo`:

```sh
virgo --help
virgo install --mode local --machine my-machine --root "$HOME/virgo"
```

Acquisition creates `~/.local/bin/virgo`, supplies its private checksum-pinned
Bun 1.3.14 runtime at `~/.local/share/virgo/bootstrap/bun/1.3.14/bin/bun`,
records its absolute path, digest and file identity in the private owner-home
`~/.local/share/virgo/bootstrap/config.json`, verifies the selected CLI, and adds the command directory to
the ordinary login profile (`.zprofile` for zsh, `.bash_profile` for Bash).
It preserves existing profile content and adds the path once. You do not need a
repository checkout, a separately installed Bun, a CLI alias, or receipt decoding.
Public artifact downloads do not require GitHub login. Docker is needed for a
local Hub's services. Hub enrollment, provider login and normal OS/provider
consent remain separate from command acquisition.

`current.json` pins the source commit/tree, exact release and the SHA-256 of
`virgo-macos-arm64`. It also pins the launcher code. The acquisition script pins
the official Bun archive and executable. Downloads use HTTPS and verify before
replacing the stable command. Repeat acquisition after an interrupted setup or
to obtain published launcher changes; a failed download or checksum leaves the
prior command usable. Acquisition does not change a Hub, Host or provider.

Install an additional Host using the existing Hub's address, Account and scoped
enrollment-credential file:

```sh
virgo install --mode host --machine my-host --root "$HOME/virgo" \
  --hub-url https://hub.example/ --account my-account \
  --network local --advertised-url http://127.0.0.1:58612/ --api-port 58612 \
  --enrollment-credential-file "$HOME/private/hub-enrollment-token"
```

The Host's example listener is loopback. It does not assume an extra proxy or
HTTPS listener. The common CLI owns validation, identity, receipts and exact
retry. Preserve the returned installation directory and plan receipts.

Install and upgrade select the verified official current release automatically.
Keep the root, machine, installed role and any custom instance identity:

```sh
virgo upgrade --mode local --machine my-machine --root "$HOME/virgo"
virgo upgrade --mode host --machine my-host --root "$HOME/virgo"
```

Use `--instance` if the original installation chose another instance name.
The root defaults to `~/virgo`; the instance defaults to `local-hub` in local
mode and `host` in Host mode. Install retains its legacy local-mode default;
upgrade and rollback require explicit `--mode local` or `--mode host`.

For an installed operation, select its actual installation directory:

```sh
virgo --directory /absolute/installation-directory host status
virgo --directory /absolute/installation-directory agent status vsp:/account:space/repo/lead
virgo --directory /absolute/installation-directory native-session status
```

The launcher reads that instance's existing active-release receipt, verifies the
cached archive checksum and its installed CLI/descriptor bytes, then passes the
arguments unchanged to its installed `bin/virgo`. The launcher and supervisor
use only the configured, checksum-verified owner-home Bun. Existing targets also
require the exact supervisor file identity and verified runner archive. Missing
or mismatched pins fail before lifecycle effects; there is no PATH, Homebrew,
launcher-package or user-selected interpreter fallback. It does not fetch or substitute
a newer CLI for an older target, or edit its configuration or state. An explicit
interpreter migration uses the independently pinned official operator CLI, while
the installed release stays unchanged. A root with
one instance can also select the existing CLI's root-aware operator commands;
use the exact instance directory for ordinary client commands.

An existing registration that uses a different interpreter needs the explicit
journaled transition before ordinary lifecycle commands:

```sh
virgo --directory /absolute/installation-directory host runtime prepare
virgo --directory /absolute/installation-directory host runtime apply --plan-id '<returned ID>'
```

Preparation binds the exact installation/configuration, configured Bun, old runner
archive and old/new launchd registration. Apply changes only the independent
supervisor interpreter; it preserves the running daemon and providers, selected
release, configuration, job label and interval. Repeat the same apply plan after
an interrupted or unknown result. Retained old/new preimages fence that retry;
ordinary lifecycle commands refuse while it is pending. No automatic rollback
or permission to reverse another operation is implied. A matching existing Bun
and registration remain unchanged; repeat acquisition never overwrites or repins
an existing mismatched runtime. Current release selection and the separately
pinned operator CLI are explicit independent metadata fields.

Three existing product commands run before the product's client selector. Select
their verified installed CLI with the stable command, which consumes only the
`--directory` selector for these routes:

```sh
virgo --directory /absolute/installation-directory skill list
virgo --directory /absolute/installation-directory skill install --root "$HOME/virgo"
virgo --directory /absolute/host-installation-directory knowledge-setup \
  --mode host --root "$HOME/virgo" --machine my-host --repository space/repo \
  --github-repository virgo-codes/virgo-release
virgo --directory /absolute/host-installation-directory capability-setup \
  --mode host --root "$HOME/virgo" --machine my-host \
  --selection /absolute/private-selection-file \
  --github-repository virgo-codes/virgo-release
```

Setup mode/root/machine/instance must match the selected installation. A custom
instance requires its original `--instance`. Host setup verifies one distribution
for the already installed release; it does not inject current. Local setup and
Host capability-plan recovery use the exact `--plan-id` and no distribution.
The existing product parser owns those options and plan/lifecycle behavior.
Skill installation accepts an optional skill name and root; its effective root
must be the selected installation root. It receives no mode/machine/instance
flags. Skill listing and setup routing do not fetch the newest CLI.

Host rollback uses its retained plan and already verified distribution cache:

```sh
virgo rollback --mode host --machine my-host --root "$HOME/virgo" \
  --plan-id '<plan ID from the successful upgrade>'
```

Local Hub rollback preserves the existing CLI's retained-distribution contract:

```sh
virgo rollback --mode local --machine my-machine --root "$HOME/virgo" \
  --plan-id '<plan ID from the successful upgrade>' \
  --manifest-directory /absolute/retained-manifest-directory
```

It may instead use the retained `--github-repository owner/repo`. Host rollback
receives no release/distribution injection and leaves the restored Host stopped;
its receipt is not an activation claim. The launcher delegates rollback to the
selected installed CLI and does not implement its own lifecycle.

An explicit recovery selection remains supported. Supplying `--release` together
with exactly one of `--github-repository`, `--manifest-directory` or `--bundle`
preserves both values and suppresses current-release injection. The existing CLI
validates the selected distribution and the role's supported options; `--bundle`
is the Host CLI's existing verified preview-bundle path. An incomplete explicit
selection is rejected before download. Quote each path; options use unique
`--name value` pairs and preserve argument boundaries.

The selected runtime is Virgo `2.0.1`, built from the source identity in
`current.json`. GitHub tags are `release-<release hash>`; Virgo's release ID is
the 64-character source-content hash. The underlying CLI remains a bundled Bun
script; the supplied private runtime keeps that implementation detail inside the
public command.

Run `bash tests/install.test.sh` for the composed isolated acquisition, login
profile/PATH, install/upgrade selection, recovery, older installed-target dispatch,
checksum/download failure and retry checks. They use real Bash, zsh and Bun with
isolated HTTPS fixtures and perform no live Hub, Host, Docker, provider or
credential operation. Separate real published-archive installed-path evidence is
recorded in the D2 delivery receipt; source publication does not roll out a fleet.

Follow the canonical [Virgo documentation](https://github.com/virgo-codes/virgo)
for supported setup, authorization, recovery and operational verification.
