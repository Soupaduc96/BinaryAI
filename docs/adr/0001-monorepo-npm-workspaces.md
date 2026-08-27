# ADR-0001 — Monorepo on npm workspaces with TypeScript project references

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

BinaryAI has several components that share types and logic: an API, a
dashboard, an indicator library, strategies, a decision engine, a backtester.
The indicator and engine code must be identical in the live path and the
backtest path — that is a correctness requirement, not a convenience.

Options considered:

1. Separate repositories with published packages.
2. A monorepo with a build orchestrator (Nx, Turborepo).
3. A monorepo on npm workspaces with TypeScript project references.
4. A single package with folders.

## Decision

Option 3: npm workspaces plus `tsc -b` project references.

## Rationale

**Against separate repos.** Publishing and version-bumping an indicator library
to change one strategy is friction with no benefit at this size, and it makes
atomic changes across a boundary impossible.

**Against Nx/Turborepo.** Both solve build orchestration and caching for large
graphs. This graph has eight packages and builds in about two seconds.
TypeScript project references already provide dependency-ordered incremental
builds. Adding an orchestrator now would be a dependency and a configuration
surface bought against a problem we do not have (development rule 14).

**Against one package.** Nothing would enforce the boundaries. The rule
"strategies must not import HTTP code" would be a convention rather than a
compile error. Separate packages make the dependency graph a checked artefact:
`@binaryai/indicators` cannot import from `@binaryai/engine` because it does not
depend on it.

**For workspaces.** No extra tooling, `npm install` links everything, and each
package declares its own dependencies — which is what makes the layering real.

## Consequences

**Good.** Boundaries are compiler-enforced. Build order is derived, not
configured. Adding a package is three files and one `npm install`. Tests run
against source via Vitest aliases, so no build step in the inner loop.

**Bad.** Packages must be built before the web app typechecks (`npm run
typecheck` handles the ordering). Adding a package means touching three
config files — `tsconfig.build.json`, `vitest.config.ts`, `package.json` — which
is easy to half-do. No remote build caching; irrelevant until CI exists.

**Neutral.** ESM throughout with `NodeNext` resolution, so relative imports carry
`.js` extensions. Correct, and mildly surprising to newcomers.

## Revisit if

Builds exceed ~30 seconds, CI needs remote caching, or a package genuinely needs
independent versioning and publication.
