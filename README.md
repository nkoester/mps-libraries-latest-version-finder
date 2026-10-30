# MPS Libraries — Latest Version Finder

Shows the newest version of each core MPS ecosystem library, grouped by MPS release line.

**→ https://nkoester.github.io/mps-libraries-latest-version-finder/**

Tracks `de.itemis.mps:extensions`, `com.mbeddr:mbeddr`, `com.mbeddr:platform`,
`org.iets3:opensource`, `org.mpsqa:all-in-one` and `com.jetbrains:mps`, plus the
JetBrains Runtime artifacts `com.jetbrains.jdk:jbr_jcef`, `jbr`, `jbrsdk` and
`jbr_nomod`, and the build tooling `de.itemis.mps:mps-gradle-plugin` with its
plugin marker `de.itemis.mps.gradle.common`, `de.itemis.mps.gradle:git-based-versioning`
and the `de.itemis.mps.build-backends` it runs, from
[artifacts.itemis.cloud](https://artifacts.itemis.cloud/repository/maven-mps/).

## How it works

The page does **not** fetch from Nexus on load. A GitHub Action fetches the
metadata every six hours and commits the result, so the page only loads a small
same-origin JSON file.

| File | Size | Loaded |
| --- | --- | --- |
| `versions.json` | ~20 KB | on page load — latest version per release line |
| `data/<group>_<artifact>.json` | 40 KB – 400 KB | on demand, when you open **All versions**, search or inspect |
| `data/deps/graph.json`, `data/deps/mps-jbr.json` | ~15 KB each | on page load — dependency chain, MPS → JBR |

Earlier versions of this page fetched `maven-metadata.xml` in the browser through
public CORS proxies. That was slow and unreliable; the proxies are no longer in
the critical path.

### Why there is no "check live" button

The page cannot fetch from Nexus at all. `artifacts.itemis.cloud` sends no
`Access-Control-Allow-Origin` header, so a browser refuses to read it directly,
and the public CORS proxies that used to fill that gap are effectively gone:

| Proxy | State (checked 2026-10-07) |
| --- | --- |
| `corsproxy.io` | `401` / `403` — paid API key now required |
| `api.codetabs.com` | `503` |
| `api.cors.lol` | `429` |
| `whateverorigin.org` | `500` |
| `crossorigin.me` | `520` |
| `cors-anywhere` | `403` — permanently gated |
| `r.jina.ai` | `200`, correct CORS headers, but strips XML to an empty document |
| `api.allorigins.win` | works intermittently; ~15 s for the 188 KB file, `520`/`522` under any concurrency |

Only allorigins worked at all, and only intermittently, so in-browser fetching
was dropped entirely rather than shipping a button that mostly fails.

**To refresh the data, run the `Update versions` workflow** (Actions → Update
versions → Run workflow). Allow a minute or two for the commit and the Pages
rebuild, then reload.

The durable fix would be a single `Access-Control-Allow-Origin` header on the
Nexus repository: direct browser fetches would then work in ~0.3 s and a live
refresh could come back.

## Reading the page

Pick an MPS release line; the six libraries' latest versions for that line appear
as coordinate cells. Each coordinate is split into `group : artifact : version`
and every cell copies on click, so you can take just the version or the whole
coordinate. Libraries that published nothing for the selected line are listed too,
marked **no build for this line** — the absence is often the answer you needed.

Under the libraries, the board lists the **JetBrains Runtime** the selected
line's MPS build is made for (see [MPS and the JetBrains Runtime](#mps-and-the-jetbrains-runtime)).

Every version shows its **publication date and time**. The *newer than* / *older than*
fields under the search box and in **All versions** filter by it (both ends
inclusive); a date filter alone lists everything in the range, newest first.

The **GitHub icon** next to a version opens its repository as of that
release. Library versions end in the commit they were built from
(`2026.1.3688.0c1ad7a` → `0c1ad7a`); MPS uses its version tag (releases only)
and the JetBrains Runtime its `jbr-release-…` tag (old 8u/11 builds have none).
The **Inspect** header links the repository and its changelog. Both come from
`repo` and `changelog` in `scripts/libraries.json`.

Libraries are ordered by the dependency stack (MPS first, then what builds on it),
not alphabetically. Development builds (`9999.9`, `999.9`) sort last and are
labelled as not being releases.

## Version handling

- **Release lines** are the leading `major.minor`, e.g. `2024.1`.
- **Latest per line** prefers the newest stable version, falling back to a
  pre-release only if the line has nothing else. Comparison is segment-wise and
  numeric, so `2021.3.10` ranks above `2021.3.9`.
- **Pre-releases** (`-SNAPSHOT`, `-RC1`, `-EAP1`, …) are kept and flagged, hidden
  behind a toggle.
- **Branch builds** — published as `<branch>.<version>`, e.g.
  `renovate-reconfigure.9999.9.24962.94d98fd-SNAPSHOT` — are counted and listed
  separately. They outnumber real releases in some repositories.
- **`9999.9` and `999.9`** are synthetic development-branch versions, not real
  MPS releases, and are labelled as such.

- **JetBrains Runtime** artifacts are grouped by Java version (`8`, `11`, `17`,
  `21`, `25`), not by MPS line. All three spellings JBR has used are read:
  `8u202-b1483.53`, `11_0_14_1-b1751.46`, `21.0.5-b631.8`.

Nothing is discarded: every version the repository reports is stored and reachable
through **All versions**.

## Publication dates

The date and time is when the version was **uploaded to artifacts.itemis.cloud**,
read from the Nexus search API (`lastModified` of the POM) and, for SNAPSHOTs,
which the search index does not cover, from the version's own `maven-metadata.xml`.
It is cached in `data/dates/<slug>.json` as a UTC timestamp
(`2026-09-17T13:35:08Z`). Nexus is the ground truth, but a regular run looks
up only versions not cached yet. Refreshes replace cached values with what
Nexus returns now: the daily 05:00 UTC run re-reads every SNAPSHOT
(`--snapshots`; a redeploy changes its time), and `--full` re-sweeps every
library to refresh all release dates. `--full` is local only, never in CI.
The page shows it in
the reader's time zone, and the *newer than* / *older than* filter compares
local calendar days. Entries cached as a bare date (before times were kept)
are looked up again by the next run.

It is not the upstream release time:

- Everything published before mid-2022 was migrated to this Nexus then and
  carries a migration date (2022-07 to 2022-11).
- MPS and JBR builds are mirrored; their date is when they were mirrored,
  sometimes long after the JetBrains release (e.g. MPS `2021.2.3` → 2024-01).

## MPS and the JetBrains Runtime

The MPS POM declares no JBR. The link comes from:

1. **`com.jetbrains.mps:mps-jbr`** — a marker POM published for every MPS release
   since 2023.3.1 (and every pre-release build) by
   [build.publish.mps](https://github.com/mbeddr/build.publish.mps). Its single
   dependency is the exact `com.jetbrains.jdk:jbr_jcef` build MPS is made for,
   taken from `mps.runtimeBuild` in the distribution's `build.properties`. It is
   tracked like any library but never shown.
2. **`scripts/mps-jbr-legacy.json`** — for MPS before 2023.3.1 only, from the
   [mbeddr MPS – JBR table](https://github.com/mbeddr/build.publish.jdk#mps---jbr-table).

`fetch-deps.mjs` resolves both into `data/deps/mps-jbr.json`. Use the exact build
where you can. Where the repository does not have it (e.g. `17.0.9-b1087.9` for
MPS 2023.3.1), the board offers the oldest newer build of the same Java version,
tagged **≥ fallback**.

The dependency chain draws this as `mps → jbr_jcef` (dashed for a fallback),
plus a dotted edge to `mps` from every library at the bottom of its chain (one
that declares no dependency): each library is built against its line's MPS,
but most POMs do not declare it, and the others reach MPS through these. The
dotted edges are drawn only; **Inspect** lists what the POMs declare.

## Build tooling and its compatibility

The **Build tooling** section of the board shows the recommended
`mps-gradle-plugin` (1.x; 2.x is marked discouraged: never established) and the
`mps-build-backends` it runs: the launcher it pins, and the newest
`modelcheck`, `execute-generators`, `execute` and `remigrate` inside its backend
range. Each row is tagged with the selected MPS line's status.

The dependency chain switches between **libraries** and **build tooling**
(top right; libraries on every page load); `mps` and `mps-gradle-plugin` are in
both. The tooling view draws
the plugin marker, the plugin with its contract edge to `mps`, the backends
its tasks resolve (dotted, in the tooling colour: not in the POM) and the POM
dependencies of all of these. **Inspect** on a tooling build draws that whole
view without MPS, with what is not part of the inspected build faded (as for
libraries).

That status is an **extracted contract**: no POM or Gradle metadata declares
MPS compatibility, so the page uses the strongest statement that exists, the
MPS versions mps-build-backends **tests** each release against, read from the
upstream sources at the commit every published version was built from. Gradle
and Java come from the plugin build (wrapper, Java target) plus minimums from
its CHANGELOG. Untested combinations may still work but are not covered.

- Method, sources, file layout and the re-extraction runbook:
  [docs/gradle-plugin-compat.md](docs/gradle-plugin-compat.md)
- Extracted + curated data: `scripts/gradle-plugin-compat.json`

## Keeping the extraction honest

Every update run checks the assumptions the extractors rely on (version
shapes, abandoned lines, missing JBR mappings, the plugin contract's sources,
page constants) and writes `data/assumptions-report.md`. It never fails the
run; a changed report is the signal to re-assess, following
[docs/reassessment.md](docs/reassessment.md) -- written so an AI agent can do
it.

## Automation

| Workflow | Schedule | Does |
| --- | --- | --- |
| `update-versions.yml` | every 6 h — 05:00, 11:00, 17:00, 23:00 UTC (SNAPSHOT dates re-read at 05:00 only) | fetch metadata, dates and POM dependencies, extract the Gradle plugin contract, check assumptions; commit `versions.json`, `data/` and `scripts/gradle-plugin-compat.json` **only if something changed** |
| `monthly-release.yml` | 1st of month, 06:00 UTC | publish one consolidated version list as a GitHub Release |

The update job skips the commit when only the timestamp would change, so
`git log versions.json` reads as a changelog of MPS library releases rather than
a wall of noise.

That is why the page header shows two times: **last change** is `generatedAt`
from `versions.json` and only moves when a version changes; **checked** is the
end of the newest `update-versions.yml` run, read from the GitHub API in the
browser (it turns red when that run failed, and links to it). GitHub often
starts scheduled runs late, so gaps of more than six hours do happen. If the API
is unavailable (60 unauthenticated requests per hour per IP), the line is left
out.

The monthly release doubles as a keep-alive: GitHub disables scheduled workflows
in repositories with 60 days of no activity.

To adjust the cron timezone, edit the `cron:` line in `update-versions.yml`
(GitHub cron is always UTC).

## Local development

```bash
node scripts/fetch-versions.mjs   # refresh versions.json + data/
node scripts/fetch-dates.mjs      # publication dates (--max <n>, --snapshots, --full)
node scripts/fetch-deps.mjs       # POM dependencies + MPS -> JBR (--max <n>)
node scripts/extract-gradle-plugin-compat.mjs  # plugin contract (clones 2 public repos)
node scripts/check-assumptions.mjs             # writes data/assumptions-report.md
npm run serve                     # http://localhost:8080
```

The page must be served over HTTP — it uses ES modules and `fetch`, so opening
`index.html` from the filesystem will not work.

Adding a library: append it to `scripts/libraries.json` and re-run the fetchers.
An optional `"kind"` marks a `runtime` artifact (grouped by Java version, kept
out of the MPS line picker), a `tool` (build tooling, grouped by major version:
`"lineScheme": "major"`) or a `marker` (fetched for its POM only, never shown).
`"discouraged": { "<line>": "<reason>" }` keeps an abandoned line from being
recommended.

```bash
node scripts/make-bundle.mjs dist  # build the monthly release artifacts
```

## Deployment

GitHub Pages, **Deploy from branch** → `main` → `/ (root)`. There is no build
step; the committed files are the site.
