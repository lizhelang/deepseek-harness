# Local desktop fork packaging

English | [中文](README.zh.md)

## Summary

This utility produces a macOS arm64 candidate application for isolated validation. It does not install or start the candidate, quit the installed application, or read Harness conversations, settings or credentials. It requires the fork's Host, Client, Web and Desktop builds and an installed base application with the same product version.

## Package a candidate

```sh
pnpm exec tsx apps/desktop/scripts/package-local-fork.mjs
```

The default base is `~/Applications/DeepSeek Harness.app`; the output is `apps/desktop/.desktop-build/local-fork/candidate/DeepSeek Harness.app`. `--base-app` selects another application of the same version. Repeat `--package` to select built workspace packages; otherwise, the utility selects changed and new packages relative to `--base-ref`, including the Web bundle and frontend. The default reference is `dsh-v0.2.0-rc.2`. Packaging refuses incomplete dependencies, missing build output, version mismatches, a running candidate, or output the utility does not own.

The candidate reuses the base application's Electron, Node, pnpm, Python, primary runtime, third-party native dependencies and unchanged workspace packages. Changed packages are replaced with the actual local `pnpm pack` payloads, preserving their nested dependencies. This is a local composition build, not a complete official release build. New external runtime dependencies require separate preparation; the utility does not silently obtain them from the user's profile or development dependency directories.

Packaging updates runtime package declarations, the shared package inventory, file-byte hashes and executable permissions, then verifies the final ASAR against its descriptor. Existing unpack locations and native signatures remain. The candidate retains the product name, Bundle ID, resource layout and version, removes official mandatory-update declarations and update feeds, updates `ElectronAsarIntegrity`, and ad-hoc signs only the outer application. It has no official Developer ID signature or notarization.

The output's `build-result.json` records the base application, base ASAR hash, source commit, dirty state, replaced packages and signature verification. `local-fork-package-set.json` and `packed/` retain this build's actual packages and SHA512 values. The installed base has no original npm tarballs, so reused packages retain only their original runtime identities; the result does not invent complete official package-set evidence. Packaging does not establish successful startup or model manufacturing validation.

Only candidate directories inside `.desktop-build/local-fork` carrying this utility's ownership marker can be rebuilt. Replacing the installed application separately requires checking live idle state, orderly exit and termination of all application processes, retaining the old application backup, and preserving `.dsh` and Electron userData. The utility does not perform replacement. Existing AEA references to the fixed `app.asar/dsh` location require retaining the original installation path.

## Validate isolated startup

Run `node apps/desktop/scripts/smoke-local-fork.mjs --app <absolute-candidate-path>` for isolated startup validation. It creates a separate Harness home, Electron userData and random listening port, enters the workspace without login, and submits no conversations or model tasks. It then requests orderly exit and verifies that application processes disappeared. On failure, it may terminate only the candidate main process it started; forced termination is not a passing result. Private diagnostic directories and results remain available. Logs switch to the private directory after the main process connects; an earlier startup failure may still use Electron's default macOS log directory.
