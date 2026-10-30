# mps-gradle-plugin compatibility: method and sources

How `scripts/gradle-plugin-compat.json` is produced, what it promises, and how
to bring it up to date. Written so that a person or an AI agent can repeat the
analysis for new versions without redoing the original research.

## The contract

**"Tested against" is the contract.** Neither the plugin nor the backends
declare MPS compatibility anywhere machine-readable on Nexus (POMs and Gradle
module metadata carry no MPS information, only `org.gradle.jvm.version`). The
strongest statement that exists is the list of MPS versions
`mbeddr/mps-build-backends` runs its integration tests with, per release.

For one plugin version and one MPS line:

- The plugin runs **the launcher it pins** (exact version in its POM / Gradle
  module metadata, `requires`) and **the newest backends inside its backend
  range** (`MPS_BUILD_BACKENDS_VERSION`, resolved by Gradle at build time; the
  range is open upwards, so the resolved backend moves as backends are
  released).
- The line is **tested** when the tested lists of *both* of those backend
  releases contain a release of the line, **pre** when only a prerelease build
  of it is listed, otherwise **untested**.
- Untested does not mean broken; it means not covered by the contract. The
  backends test one release per year (e.g. 2023.2, 2024.1, 2025.1, 2026.1), so
  lines in between are never "tested".
- The **curated** minimums (below) are hard requirements from the plugin
  changelog: a plugin older than the minimum for a line is known not to work.

Gradle and Java are reported as facts of the plugin build: the Gradle version
it was built with (wrapper) and its Java target, plus curated minimums from the
changelog. No source states a maximum Gradle version.

## Sources

Published versions end in the short hash of the commit they were built
from: `1.31.0.1.1243113` -> plugin commit `1243113`, `1.27.4.239.aeb5185` ->
backends commit `aeb5185`. Versions without one (plugin `1.32.0` onwards)
are found by their release tag, tried as `<artifactId>-<version>`
(`mps-gradle-plugin-1.32.0`), `v<version>`, `<version>`. All extracted facts
are read at that commit.

| Fact | Repository | Location at the commit | Since |
| --- | --- | --- | --- |
| Backend range | `mbeddr/mps-gradle-plugin` | `MPS_BUILD_BACKENDS_VERSION = "..."` in a `*.kt` file (`src/main/kotlin/de/itemis/mps/gradle/Common.kt`) | 2022-07 (`1.+` before), removed in 1.32.0 |
| Backend range (1.32.0+) | `mbeddr/mps-gradle-plugin` | `BACKENDS_MIN_RELEASE` / `BACKENDS_MAX_RELEASE` in a `*.kt` file (`src/main/kotlin/de/itemis/mps/gradle/BuildBackend.kt`), recorded as `[min,max)`; `latest.release`, so SNAPSHOTs and prereleases are excluded | 1.32.0 |
| Gradle built with | `mbeddr/mps-gradle-plugin` | `gradle/wrapper/gradle-wrapper.properties`, `distributionUrl` | always |
| Java target | `mbeddr/mps-gradle-plugin` | `build.gradle(.kts)`: `JavaVersion.VERSION_*`, else `jvmTarget`, else `.java-version` | always |
| Pinned launcher | Nexus | plugin POM dependency `de.itemis.mps.build-backends:launcher` (`data/deps/de.itemis.mps_mps-gradle-plugin.json`) | plugin 1.24 |
| Tested MPS versions | `mbeddr/mps-build-backends` | `supportedMpsVersions=` in `gradle.properties` | backends 1.22.2, 2025-05 |
| Tested MPS versions (older) | `mbeddr/mps-build-backends` | `SUPPORTED_MPS_VERSIONS = arrayOf(...)` in `integration-tests/build.gradle.kts` | 2022-02 |
| Curated minimums | `mbeddr/mps-gradle-plugin` | `CHANGELOG.md` prose | -- |

Tested lists mix releases (`2024.1.6`) and prerelease build numbers
(`263.6259.45` = 2026.3 prerelease: `YYR` -> `20YY.R`).

Abandoned lines are excluded by configuration, not by the extractor:
plugin `2.x` is marked `discouraged` in `scripts/libraries.json` (published
2022-07 to 2024-02, never established; Nexus' own `<latest>` wrongly points at
it).

## Running the extraction

```bash
node scripts/fetch-versions.mjs          # plugin + backend versions from Nexus
node scripts/fetch-deps.mjs              # plugin POMs -> pinned launcher
node scripts/extract-gradle-plugin-compat.mjs [--repos <cache dir>]
```

The extractor clones both repositories (read-only, never built or run) into
`$TMPDIR/mps-compat-sources`, rewrites `extracted` and keeps `curated`. It
reports versions whose commit cannot be found (e.g. rebased away; recorded as
`commit: null`) and backend commits without a tested list. It runs in the
`Update versions` workflow after `fetch-deps`, so new versions are matched
automatically.

## File layout

```text
$comment            states that the file is extracted + curated
contract            "tested-against"
extracted.plugin    version -> { commit, backendsRange, gradle, java, launcher }
extracted.backends  artifact -> version -> commit
extracted.testedMps commit -> [MPS versions tested at that commit] (null: none)
curated             hand-maintained, see below
```

The page computes the contract with `pluginContract()` in `versions-lib.js`.

## Curated facts

Only `curated` is edited by hand. Each entry names its source.

- `pluginMinimumForMps`: `{ mps, plugin, source }` -- the plugin version a
  line (and every later line) needs. Add one when a CHANGELOG entry says a
  task now supports, or fixes something for, "MPS X and above".
- `pluginMpsDropped`: `{ mps, plugin, source }` -- from that plugin version on,
  lines up to `mps` no longer work.
- `pluginGradle`: `{ plugin, gradleMin | note, source }` -- Gradle minimums and
  notable Gradle fixes.
- `pluginJava`: `{ plugin, javaMin, source }`.
- `reviewedUpTo` / `reviewedAt`: the last plugin version whose CHANGELOG entry
  was read, and when.

## Re-assessment runbook (for an agent)

Run this when a new plugin or backends release appears, when the extractor
reports problems, or when `scripts/check-assumptions.mjs` flags the
compatibility checks.

1. **Re-run the extraction** (commands above). Note its summary line.
2. **Check the sources still exist.** If a new version has no tested list, or
   no backend range / Gradle / Java, open the repository at the version's
   commit and find where the fact moved (renamed constant, version catalog,
   moved test matrix). Extend the matching function in
   `scripts/extract-gradle-plugin-compat.mjs` (`testedMps`, `pluginFacts`)
   with the new location, keeping the old ones for older commits. Update the
   Sources table above.
3. **Read the plugin CHANGELOG** from `reviewedUpTo` to the newest release.
   For each entry mentioning an MPS version, Gradle, Java or the backends
   minimum, add a curated entry with its `source`. Bump `reviewedUpTo` and
   `reviewedAt`.
4. **Read the backends' CHANGELOGs** (`CHANGELOG.md`, `launcher/CHANGELOG.md`,
   `project-loader/CHANGELOG.md`) for statements that contradict the tested
   lists (e.g. a line explicitly unsupported). Record those as curated
   entries; do not edit `extracted`.
5. **Check for a new or abandoned line.** A new plugin major, a line with no
   release for a long time while another is active, or Nexus `<latest>`
   pointing at an old line: update `discouraged` in `scripts/libraries.json`.
6. **Verify a sample.** For the newest plugin version, confirm by hand: the
   POM's launcher version, `MPS_BUILD_BACKENDS_VERSION` at its commit, and
   `supportedMpsVersions` at the resolved backend's commit. They must match the
   page's Inspect view for that version.
7. **Commit** `scripts/gradle-plugin-compat.json` (and any extractor or doc
   change) with a message naming the versions reviewed.

## Known limitations

- The contract only covers MPS versions the backends test; most lines between
  yearly releases are "untested" by construction.
- The resolved backend is "newest in range today"; builds that lock their
  dependencies can use older backends with different tested lists.
- The plugin's own MPS-specific code (e.g. `--add-opens` for migrations) is not
  covered by any test matrix; the curated minimums are the only signal.
- No maximum Gradle version is known; the wrapper version is what the plugin
  was built and tested with.
