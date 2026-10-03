# Virgo release bootstrap

This repository publishes the small, auditable bootstrap for Virgo on macOS arm64.

`current.json` names one immutable GitHub release and the SHA-256 of its `virgo-macos-arm64` CLI asset. `install.sh` requires Bun and an authenticated GitHub CLI, downloads that exact asset, verifies its checksum, and runs it with Bun. A local Hub installation also requires Docker. An additional Host connects to an existing Hub and does not install Hub services.

Run it with a machine identifier, for example:

```sh
./install.sh --machine my-machine
# Equivalent explicit form:
./install.sh install --mode local --machine my-machine
```

The default installation root is `~/virgo`. Pass `--root /absolute/path` to choose another root. The bootstrap does not configure a Hub, Host, adapter, credential, hook, or provider itself; the verified common CLI owns those steps.

To install an additional Host, use the existing Hub's address, Account and an
independently prepared enrollment-credential file. The common CLI validates these
inputs and preserves the Host's identity on an exact retry:

```sh
./install.sh install --mode host --machine my-machine \
  --root "$HOME/virgo" --hub-url https://hub.example/ --account my-account \
  --network local --advertised-url http://127.0.0.1:58612/ --api-port 58612 \
  --enrollment-credential-file "$HOME/private/hub-enrollment-token"
```

The Host example advertises its actual loopback listener. It does not assume
an additional HTTPS listener or proxy on the Host.

Update from a reviewed, current checkout of this canonical bootstrap repository.
Keep the existing root, machine and optional `--instance` identity the same, and
select the installed role explicitly:

```sh
./install.sh upgrade --mode local --machine my-hub-machine --root "$HOME/virgo"
./install.sh upgrade --mode host --machine my-machine --root "$HOME/virgo"
./install.sh rollback --mode host --machine my-machine --root "$HOME/virgo" \
  --plan-id '<plan ID returned by the successful upgrade>'
```

Local mode updates the existing local Hub; its instance defaults to `local-hub`.
Host mode updates the additional Host; its instance defaults to `host`. Supply
`--instance` when the original installation used another instance name. Upgrade
requires an explicit `--mode local` or `--mode host`; the legacy default applies
only to installation. Bootstrap rollback currently exposes the Host plan/cache
route; local Hub rollback remains an installed-CLI operation.

Host upgrade retains installed Hub, Account, credential and provider configuration;
those inputs are not accepted again as update flags. Rollback uses the verified
prior artifact in the installed plan/cache, takes no release/distribution flags,
and leaves the restored Host stopped. Its returned state is not an activation
claim. `--machine` is always required.

All options use unique `--name value` pairs. Quote paths containing spaces. The
wrapper rejects malformed or duplicate options before downloading. It owns
`--mode` and forbids caller-supplied `--release`, `--github-repository`,
`--manifest-directory` and `--bundle`, including `--name=value` forms. Install and
upgrade always receive the exact metadata release and
`--github-repository virgo-codes/virgo-release`; rollback receives neither pin.

This is `2.0.1`, built from the source commit recorded in `current.json`.
The metadata pins the reviewed integrated source and the immutable release that
contains the Host install, upgrade and rollback commands documented above. The
wrapper never substitutes an unpinned artifact or a local source checkout.
The native launcher is a bundled Bun executable script. It is not a standalone
Bun-free binary. See the [source README](https://github.com/virgo-codes/virgo) for
implemented behavior, field evidence, and remaining implementation boundaries.

GitHub tags use `release-<release hash>`; the Virgo release ID itself remains the
64-character source-content hash. GitHub rejects tags consisting only of such a hash.

Run the isolated bootstrap checks with `bash tests/install.test.sh`. They execute
the real shell wrapper and Bun with fake GitHub/download fixtures; no network,
Host, Hub, Docker service or credential access is used.

Memory is enabled after Hub and Hosts run the same published release. Use the
verified installed CLI with the source's [Memory capability and native-hook
instructions](https://github.com/virgo-codes/virgo/blob/main/docs/operations/hub-capability-plans.md).
Keep existing provider sessions, retain the original installation plan for resume
or rollback, and verify native capture, search and restoration after activation.
The bootstrap does not silently enable Memory or replace existing Hub data.
Passwordless sudo is optional; only a specific privileged machine operation uses
the operator's normal sudo authorization.

The selected release also supports reconnecting an existing Host through the
installed CLI's `host hub retarget` command, preserving its keypair, native
sessions and unrelated settings. Use the source's [existing-Host recovery
instructions](https://github.com/virgo-codes/virgo/blob/main/README.md#installation-root-and-working-data)
for the scoped enrollment credential, offline stop and retry sequence. Stopped
managed sessions stay out of automatic claims; a proved-dead owned pane resumes
its original session. These recovery operations do not migrate unavailable
historical Hub records or replace provider histories.
