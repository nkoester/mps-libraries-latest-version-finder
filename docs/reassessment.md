# Re-assessment runbook

The data on this page is extracted automatically, but each extractor rests on
assumptions about how artifacts are versioned and where facts live. This
runbook is for the person or AI agent who checks those assumptions when new
versions appear, so that versions and deprecations keep being extracted
correctly without redoing the original analysis.

## When to run

- `data/assumptions-report.md` lists an error or warning. The `Update versions`
  workflow regenerates it every run (and shows it in the run summary); it only
  changes when the findings change, so a new commit touching it is the signal.
- A new MPS release line, a new tracked artifact, or a release of
  `mps-gradle-plugin` / `mps-build-backends`.
- Before relying on the page for a decision about an unfamiliar combination.

## Steps

1. Refresh everything and re-run the checks:

   ```bash
   node scripts/fetch-versions.mjs
   node scripts/fetch-dates.mjs
   node scripts/fetch-deps.mjs --max 3000
   node scripts/extract-gradle-plugin-compat.mjs
   node scripts/check-assumptions.mjs
   ```

2. Work through `data/assumptions-report.md` with the table below. Fix the
   cause (configuration, extractor, curated data), not the report.
3. For mps-gradle-plugin compatibility, follow the runbook in
   [gradle-plugin-compat.md](gradle-plugin-compat.md) (it includes reading new
   CHANGELOG entries, which no check can do).
4. Re-run step 1 until the report holds no errors and every remaining warning
   is understood. Commit data, configuration and doc changes together; name
   the versions reviewed in the message.

## Checks

| Check | Assumption | When it fires, do this |
| --- | --- | --- |
| `fetch` | Nexus serves every tracked `maven-metadata.xml`. | Check the URL in `scripts/libraries.json`; the artifact may have moved or been renamed. |
| `version-shape` | Every release fits its library's line scheme (`mps`: `X.Y…`, `java`: `8u…`/`11_0…`/`21.0…`, `major`: `N.…`). Versions starting with a letter are branch builds. | A new scheme: extend `lineOf` in `versions-lib.js`, or set `lineScheme` for the library. |
| `abandoned-line` | The highest non-discouraged line is the active one. Fires when a line ranks above the one holding the newest upload (the mps-gradle-plugin 2.x case). | Confirm the line is abandoned (dates, upstream README/CHANGELOG), then add it to `discouraged` in `scripts/libraries.json` with a reason. |
| `recommended-line` | The recommended line holds the newest upload. | Usually follows from `abandoned-line`; otherwise a legitimate maintenance release on an older line -- no action. |
| `development-line` | Synthetic development versions (`9999.9`, `999.9`) are known. | Add the new one to `DEVELOPMENT_LINES` in `versions-lib.js`. |
| `mps-jbr` | Every MPS release since 2023.3.1 gets a `com.jetbrains.mps:mps-jbr` marker within two weeks. | Check the marker on Nexus. If it is missing for good, add the version to `scripts/mps-jbr-legacy.json` from the MPS distribution's `build.properties` (`mps.runtimeBuild`) and note the source. |
| `dates` | Every version has a publication date. | Informational while the incremental fetch catches up; persistent gaps mean the Nexus search API stopped returning the component (check `fetch-dates.mjs`). |
| `compat` | Each new mps-gradle-plugin release is in the extracted contract with backend range, Gradle and Java, and the backends it resolves have a tested MPS list. | Re-run the extractor; if facts stay empty, a source moved: [gradle-plugin-compat.md](gradle-plugin-compat.md), step 2. |
| `compat-curated` | The plugin CHANGELOG has been reviewed up to the newest release. | [gradle-plugin-compat.md](gradle-plugin-compat.md), step 3; bump `curated.reviewedUpTo`. |
| `page-constants` | `DEFAULT_LINE` exists; `KEY_LINES` include the newest MPS line. | Update the constants at the top of the script in `index.html`. |

## Assumptions no check covers

Re-read these when something looks off on the page:

- **Publication dates** are Nexus upload dates, not upstream release dates
  (see README). Mirrored MPS/JBR builds carry their mirroring date.
- **Branch builds** are recognised by a leading letter. A branch named with a
  leading digit would be taken for a release.
- **Dependencies** come from POMs only. The dotted "built against MPS" edges and
  the MPS -> JBR and plugin contracts are derived separately.
- **The MPS -> JBR map** uses `jbr_jcef` (what the marker names) as primary;
  `MARKER_SINCE` in `fetch-deps.mjs` assumes no markers before 2023.3.1.
- **Plugin contract**: "tested against" lists from mps-build-backends are the
  contract; see the limitations in [gradle-plugin-compat.md](gradle-plugin-compat.md).

When you find a new assumption, add a check to `scripts/check-assumptions.mjs`
and a row above.
