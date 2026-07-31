# Contributing to @cruglobal/flags

Thanks for your interest in contributing. This document covers the
conventions and toolchain expectations for the repository.

## Toolchain

This project pins the exact Node.js version in a repo-root
`.tool-versions` file. Contributors use [`asdf`](https://asdf-vm.com/)
to read that file locally; CI uses `actions/setup-node@v6` with
`node-version-file: .tool-versions`, so local and CI resolve the same
interpreter from the same single source. Install `asdf`, add the
Node.js plugin, and run `asdf install` from the repo root before
`npm install`.

```sh
asdf plugin add nodejs
asdf install
npm install
```

Do **not** bypass `asdf` by installing Node.js through a different mechanism
(e.g. Homebrew, fnm, nvm) for contribution work — divergent versions cause
hard-to-debug failures and make PR reviews inconsistent. CI reads the same
`.tool-versions` file, so a green local build implies a green CI build.

Note that the _published library_ supports Node.js >= 20 (it needs a global
`fetch`); the `.tool-versions` pin only governs the development environment.

## Workflow

1. Keep commits focused, and keep PRs to one concern.
2. Before opening a PR, run the full local check:
   ```sh
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```
3. Design-level changes require updating
   [`docs/design.md`](docs/design.md) in the same PR. The design doc is
   authoritative; drift between docs and code is a bug.
4. Commit messages follow
   [Conventional Commits](https://www.conventionalcommits.org/) —
   release-please derives the version bump and CHANGELOG from them
   (`feat:` -> minor, `fix:` -> patch, `feat!:`/`BREAKING CHANGE:` ->
   major once past 1.0).
5. PRs merge with **squash merge**. Write the PR title as a conventional
   commit, because it becomes the commit message on `main`.

## Failing-test-first for bug fixes and features

**Bug fixes and feature PRs must lead with a failing test.** Structure
your commits so the PR history reads:

1. **First commit** — adds a test that reproduces the bug or asserts
   the new feature's behaviour. CI should fail on this commit alone.
2. **Subsequent commits** — the fix or implementation, with the test
   flipping from red to green.

This applies equally to **issue reports**: when filing a bug, include
a minimal failing test (or the flag document + the `enabled()` call and
the value you expected) that demonstrates the problem. Reproducible
issues are triaged first.

Why: it proves the behaviour wasn't already covered, documents the
expected outcome, and prevents regressions. On merge the repo uses
squash, so the two commits collapse into one on `main` — but the
reviewing history stays clean.

### Exemptions

The failing-test-first requirement does **not** apply to:

- **Documentation-only changes** (README, docs/\*\*, JSDoc-only edits).
- **CI / workflow changes** (`.github/**`).
- **Dependency updates** (Dependabot PRs, manual bumps).
- **Chore / refactor** PRs that don't change observable behaviour.

If you're unsure which bucket a PR falls into, include a test — it's
always accepted, even when not required.

## Code conventions

- TypeScript `strict: true`. No implicit `any`; no unchecked indexed
  access.
- **Zero runtime dependencies** in the published library. Dev dependencies
  are fine.
- ESM + CJS must both work.
- `enabled()` must remain synchronous, total, and I/O-free. If a change
  could make it throw, the change is wrong.
- Tests use a real `node:http` server (`test/helpers/server.ts`) rather
  than a stubbed `fetch`, so `ETag` revalidation and abort behaviour are
  exercised for real.
- The live test (`test/live.test.ts`, `npm run verify:live`) talks to the
  production flag service and is gated on `CRU_FLAGS_LIVE=1`. It must
  stay skipped in CI.

## License

By contributing, you agree that your contributions will be licensed under
the [BSD-3-Clause License](LICENSE).
