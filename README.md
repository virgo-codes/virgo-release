# Virgo release bootstrap

This repository publishes the small, auditable bootstrap for Virgo on macOS arm64.

`current.json` names one immutable GitHub release and the SHA-256 of its `virgo-macos-arm64` CLI asset. `install.sh` requires Bun, Docker for local Hub services, and an authenticated GitHub CLI, downloads that exact asset, verifies the checksum before execution, and delegates to the common CLI's local installer.

Run it with a machine identifier, for example:

```sh
./install.sh --machine my-machine
```

The default installation root is `~/virgo`. Pass `--root /absolute/path` to choose another root. The bootstrap does not configure a Hub, Host, adapter, credential, hook, or provider itself; the verified common CLI owns those steps.

This is `0.1.0-preview.1`, built from the source commit recorded in `current.json`.
The native launcher is a bundled Bun executable script. It is not a standalone
Bun-free binary. See the [source README](https://github.com/virgo-codes/virgo) for
implemented behavior, field evidence, and preview limitations.
