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
  --network tailscale --advertised-url https://my-machine.example/ \
  --enrollment-credential-file "$HOME/private/hub-enrollment-token"
```

Update the same Host from a reviewed, current checkout of this canonical bootstrap
repository. Keep its root, machine and optional `--instance` identity the same:

```sh
./install.sh upgrade --mode host --machine my-machine --root "$HOME/virgo"
./install.sh rollback --mode host --machine my-machine --root "$HOME/virgo" \
  --plan-id '<plan ID returned by the successful upgrade>'
```

Upgrade retains installed Hub, Account, credential and provider configuration;
those inputs are not accepted again as update flags. Rollback uses the verified
prior artifact in the installed plan/cache, takes no release/distribution flags,
and leaves the restored Host stopped. Its returned state is not an activation
claim. The optional instance defaults to `host`; `--machine` is always required.

All options use unique `--name value` pairs. Quote paths containing spaces. The
wrapper rejects malformed or duplicate options before downloading. It owns
`--mode` and forbids caller-supplied `--release`, `--github-repository`,
`--manifest-directory` and `--bundle`, including `--name=value` forms. Install and
upgrade always receive the exact metadata release and
`--github-repository virgo-codes/virgo-release`; rollback receives neither pin.

This is `2.0.1`, built from the source commit recorded in `current.json`.
The metadata currently still pins source `9616ea22a9bda6e36851929d7a3297a64de3f835`.
Adding these wrapper commands does not publish or select a newer CLI: Host install,
upgrade and rollback require the release owner to publish an accepted artifact
containing those commands and advance `current.json`. Until then, the pinned older
CLI may refuse them. This wrapper never substitutes an unpinned artifact or a
local source checkout.
The native launcher is a bundled Bun executable script. It is not a standalone
Bun-free binary. See the [source README](https://github.com/virgo-codes/virgo) for
implemented behavior, field evidence, and remaining implementation boundaries.

GitHub tags use `release-<release hash>`; the Virgo release ID itself remains the
64-character source-content hash. GitHub rejects tags consisting only of such a hash.

Run the isolated bootstrap checks with `bash tests/install.test.sh`. They execute
the real shell wrapper and Bun with fake GitHub/download fixtures; no network,
Host, Hub, Docker service or credential access is used.
