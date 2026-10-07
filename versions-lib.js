/**
 * Shared version logic.
 *
 * Imported by both the Node generator (scripts/fetch-versions.mjs) and the
 * browser (index.html), so sorting and grouping can never drift apart.
 */

/**
 * Pre-release markers, anchored at the end of the version string.
 *
 * Anchoring matters: MPS libraries publish versions like `2024.1.3193.ccbdc48`
 * where the last segment is a git hash. An unanchored search would be at risk
 * of classifying a hash as a pre-release.
 */
const PRE_RELEASE_RE =
  /(?:^|[.\-_+])(snapshot|alpha|beta|rc\d*|eap\d*|m\d+|pre|preview|dev|nightly)(?:[.\-_+]?\d+)?$/i;

/** Leading `<major>.<minor>`, e.g. `2024.1.3193.ccbdc48` -> `2024.1`. */
const LINE_RE = /^(\d+)\.(\d+)/;

/**
 * mbeddr, IETS3, the MPS extensions and MPS-QA publish builds off their
 * development branch under a synthetic version. These sort above (or far below)
 * every real release line, so they need labelling rather than hiding.
 * `org.mpsqa` used `999.9` before switching to `9999.9`.
 */
export const DEVELOPMENT_LINES = new Set(['9999.9', '999.9']);

export function isDevelopmentLine(line) {
  return DEVELOPMENT_LINES.has(line);
}

export function lineLabel(line) {
  return isDevelopmentLine(line) ? `master / nightly (${line})` : line;
}

/**
 * Feature-branch builds are published as `<branch>.<version>`, e.g.
 * `renovate-reconfigure.9999.9.24962.94d98fd-SNAPSHOT`. They outnumber real
 * releases in some repositories, so they are counted and displayed separately
 * rather than mixed into the release lines.
 */
export function branchOf(version) {
  if (/^\d/.test(version)) return null;
  return version.split(/\.(?=\d)/)[0];
}

export function isPreRelease(version) {
  return PRE_RELEASE_RE.test(version);
}

/** The MPS release line a version belongs to, or null if it has no `X.Y` prefix. */
export function lineOf(version) {
  const match = version.match(LINE_RE);
  return match ? `${match[1]}.${match[2]}` : null;
}

function splitVersion(version) {
  return version.split(/[.\-_+]/).filter((segment) => segment.length > 0);
}

function compareSegment(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  // A numeric segment outranks an alphanumeric one, so `2024.1.3193` sorts
  // above `2024.1.3193.ccbdc48`.
  if (aNumeric) return 1;
  if (bNumeric) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Segment-wise version comparison. Unlike a lexicographic sort this ranks
 * `2021.3.10` above `2021.3.9`.
 */
export function compareVersions(a, b) {
  const left = splitVersion(a);
  const right = splitVersion(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const result = compareSegment(left[i] ?? '0', right[i] ?? '0');
    if (result !== 0) return result;
  }
  return 0;
}

/** Extract every `<version>` from a maven-metadata.xml document. */
export function parseMetadata(xmlText) {
  const versions = [];
  const re = /<version>([^<]+)<\/version>/g;
  let match;
  while ((match = re.exec(xmlText)) !== null) {
    versions.push(match[1].trim());
  }
  return versions;
}

/** Filename-safe identifier for a library, used for its per-library data file. */
export function slugFor(library) {
  return `${library.groupId}_${library.artifactId}`.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Group versions into release lines.
 *
 * Every version is retained, including pre-releases — they are flagged rather
 * than dropped so the UI can offer them on demand. Only the choice of `latest`
 * prefers a stable version, falling back to a pre-release if a line has nothing
 * else.
 */
export function buildLibraryData(rawVersions) {
  const seen = new Set();
  const all = [];
  for (const raw of rawVersions) {
    const version = raw.trim();
    if (!version || seen.has(version)) continue;
    seen.add(version);
    all.push({
      v: version,
      pre: isPreRelease(version),
      line: lineOf(version),
      branch: branchOf(version),
    });
  }
  all.sort((a, b) => compareVersions(b.v, a.v));

  const byLine = new Map();
  const branchBuilds = [];
  for (const entry of all) {
    if (entry.branch !== null) {
      branchBuilds.push({ v: entry.v, pre: entry.pre, branch: entry.branch });
      continue;
    }
    if (!entry.line) continue;
    if (!byLine.has(entry.line)) byLine.set(entry.line, []);
    byLine.get(entry.line).push({ v: entry.v, pre: entry.pre });
  }

  const lines = [...byLine.entries()]
    .map(([line, versions]) => {
      // `versions` inherits the descending order of `all`.
      const latestStable = versions.find((entry) => !entry.pre);
      const latest = latestStable ?? versions[0];
      return {
        line,
        latest: latest.v,
        latestIsPreRelease: !latestStable,
        total: versions.length,
        stable: versions.filter((entry) => !entry.pre).length,
        versions,
      };
    })
    .sort((a, b) => compareVersions(b.line, a.line));

  // Counts describe release versions; branch builds are reported separately so
  // the headline numbers reflect what is actually consumable.
  const released = all.filter((entry) => entry.branch === null && entry.line);
  return {
    lines,
    branchBuilds,
    total: all.length,
    released: released.length,
    stable: released.filter((entry) => !entry.pre).length,
    preRelease: released.filter((entry) => entry.pre).length,
    branchCount: branchBuilds.length,
    branches: [...new Set(branchBuilds.map((entry) => entry.branch))].sort().length,
  };
}

/** Repository links for one concrete version of a library. */
export function artifactUrls(library, version) {
  const base = library.metadataUrl.replace('maven-metadata.xml', '');
  const browseBase = base.replace('/repository/', '/service/rest/repository/browse/');
  return {
    pom: `${base}${version}/${library.artifactId}-${version}.pom`,
    zip: `${base}${version}/${library.artifactId}-${version}.zip`,
    browse: `${browseBase}${version}`,
    folder: browseBase,
  };
}

export function mavenCoordinate(library, version) {
  return `${library.groupId}:${library.artifactId}:${version}`;
}
