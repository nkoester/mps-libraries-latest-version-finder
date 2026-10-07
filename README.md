# MPS Libraries — Latest Version Finder

Shows the newest version of each core MPS ecosystem library, grouped by MPS release line.

**→ https://nkoester.github.io/mps-libraries-latest-version-finder/**

Tracks `de.itemis.mps:extensions`, `com.mbeddr:mbeddr`, `com.mbeddr:platform`,
`org.iets3:opensource`, `org.mpsqa:all-in-one` and `com.jetbrains.mps:mps` from
[artifacts.itemis.cloud](https://artifacts.itemis.cloud/repository/maven-mps/).

## How it works

The page does **not** fetch from Nexus on load. A GitHub Action fetches the
metadata every six hours and commits the result, so the page only loads a small
same-origin JSON file.

| File | Size | Loaded |
| --- | --- | --- |
| `versions.json` | ~20 KB | on page load — latest version per release line |
| `data/<group>_<artifact>.json` | 40 KB – 300 KB | on demand, when you open **All versions** |

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

Nothing is discarded: every version the repository reports is stored and reachable
through **All versions**.

## Automation

| Workflow | Schedule | Does |
| --- | --- | --- |
| `update-versions.yml` | every 6 h — 05:00, 11:00, 17:00, 23:00 UTC | fetch metadata, commit `versions.json` + `data/` **only if versions changed** |
| `monthly-release.yml` | 1st of month, 06:00 UTC | publish one consolidated version list as a GitHub Release |

The update job skips the commit when only the timestamp would change, so
`git log versions.json` reads as a changelog of MPS library releases rather than
a wall of noise.

The monthly release doubles as a keep-alive: GitHub disables scheduled workflows
in repositories with 60 days of no activity.

To adjust the cron timezone, edit the `cron:` line in `update-versions.yml`
(GitHub cron is always UTC).

## Local development

```bash
node scripts/fetch-versions.mjs   # refresh versions.json + data/
npm run serve                     # http://localhost:8080
```

The page must be served over HTTP — it uses ES modules and `fetch`, so opening
`index.html` from the filesystem will not work.

Adding a library: append it to `scripts/libraries.json` and re-run the fetcher.

```bash
node scripts/make-bundle.mjs dist  # build the monthly release artifacts
```

## Deployment

GitHub Pages, **Deploy from branch** → `main` → `/ (root)`. There is no build
step; the committed files are the site.
