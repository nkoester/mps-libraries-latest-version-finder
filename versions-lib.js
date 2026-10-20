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
 * Leading Java feature version of a JetBrains Runtime build. JBR has used
 * three spellings: `8u202-b1483.53`, `11_0_14_1-b1751.46` and `21.0.5-b631.8`.
 */
const JAVA_LINE_RE = /^(\d+)(?=[._u-]|$)/;

/**
 * Library roles, set per entry in scripts/libraries.json:
 *
 *   (none)    an MPS library, grouped by MPS release line
 *   runtime   a JetBrains Runtime artifact, grouped by Java version and kept
 *             out of the MPS line picker
 *   marker    tracked for its POM dependencies only, never shown
 */
export const isRuntime = (library) => library?.kind === 'runtime';
export const isMarker = (library) => library?.kind === 'marker';

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
  if (isDevelopmentLine(line)) return `master / nightly (${line})`;
  // Only runtime lines are a bare number; MPS lines are always `X.Y`.
  return /^\d+$/.test(line) ? `Java ${line}` : line;
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

/**
 * Maven SNAPSHOT versions store their files under a timestamped name
 * (`x-1.0-20261013.030247-1.pom`), never under `x-1.0-SNAPSHOT.pom`.
 */
export function isSnapshot(version) {
  return /-SNAPSHOT$/i.test(version);
}

/**
 * The timestamped file version for one extension, read from a SNAPSHOT
 * version's own maven-metadata.xml. Null if the metadata does not say.
 */
export function snapshotFileVersion(metadataXml, extension) {
  for (const [, block] of metadataXml.matchAll(/<snapshotVersion>([\s\S]*?)<\/snapshotVersion>/g)) {
    if (/<classifier>/.test(block)) continue;
    if (block.match(/<extension>\s*([^<]*?)\s*<\/extension>/)?.[1] !== extension) continue;
    const value = block.match(/<value>\s*([^<]*?)\s*<\/value>/)?.[1];
    if (value) return value;
  }
  // Older metadata only records the latest timestamp and build number.
  const timestamp = metadataXml.match(/<timestamp>\s*([^<]*?)\s*<\/timestamp>/)?.[1];
  const buildNumber = metadataXml.match(/<buildNumber>\s*([^<]*?)\s*<\/buildNumber>/)?.[1];
  const base = metadataXml.match(/<version>\s*([^<]*?)-SNAPSHOT\s*<\/version>/i)?.[1];
  return timestamp && buildNumber && base ? `${base}-${timestamp}-${buildNumber}` : null;
}

/**
 * The release line a version belongs to, or null if it has none: `X.Y` for
 * MPS libraries, the Java version for runtime artifacts.
 */
export function lineOf(version, scheme = 'mps') {
  if (scheme === 'java') return version.match(JAVA_LINE_RE)?.[1] ?? null;
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
  // Same letters, then a number (`b944` vs `b1145`, `rc9` vs `rc10`): compare
  // the number, so JBR build numbers order correctly.
  const aTagged = a.match(/^([a-z]+)(\d+)$/i);
  const bTagged = b.match(/^([a-z]+)(\d+)$/i);
  if (aTagged && bTagged && aTagged[1] === bTagged[1]) return Number(aTagged[2]) - Number(bTagged[2]);
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

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Branch names may contain `&`, which the metadata stores as `&amp;`. */
function decodeXml(text) {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (whole, name) => XML_ENTITIES[name]);
}

/** Extract every `<version>` from a maven-metadata.xml document. */
export function parseMetadata(xmlText) {
  const versions = [];
  const re = /<version>([^<]+)<\/version>/g;
  let match;
  while ((match = re.exec(xmlText)) !== null) {
    versions.push(decodeXml(match[1].trim()));
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
export function buildLibraryData(rawVersions, { lineScheme = 'mps' } = {}) {
  const seen = new Set();
  const all = [];
  for (const raw of rawVersions) {
    const version = raw.trim();
    if (!version || seen.has(version)) continue;
    seen.add(version);
    all.push({
      v: version,
      pre: isPreRelease(version),
      line: lineOf(version, lineScheme),
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

/**
 * Repository links for one concrete version of a library.
 *
 * `pom`/`zip` follow the release naming. For a SNAPSHOT they do not exist:
 * read `versionMetadata`, then `pomFor(snapshotFileVersion(...))`.
 */
export function artifactUrls(library, version) {
  const base = library.metadataUrl.replace('maven-metadata.xml', '');
  const browseBase = base.replace('/repository/', '/service/rest/repository/browse/');
  // Branch names may carry `#` (`fix#1474.2024.1...`), which would otherwise
  // end the path and start a fragment.
  const folder = encodeURIComponent(version);
  const file = (fileVersion, extension) =>
    `${base}${folder}/${library.artifactId}-${encodeURIComponent(fileVersion)}.${extension}`;
  return {
    pom: file(version, 'pom'),
    zip: file(version, 'zip'),
    pomFor: (fileVersion) => file(fileVersion, 'pom'),
    versionMetadata: `${base}${folder}/maven-metadata.xml`,
    browse: `${browseBase}${folder}`,
    folder: browseBase,
  };
}

/* ------------------------------------------------------------------- dates */

/**
 * Whether a `YYYY-MM-DD` date lies within [from, to]; either bound may be
 * empty. Same-format ISO dates compare correctly as strings.
 */
export function inDateRange(date, from, to) {
  if (!from && !to) return true;
  if (!date) return false;
  return (!from || date >= from) && (!to || date <= to);
}

/* --------------------------------------------------------------- MPS -> JBR */

/**
 * The runtime build an MPS version is built with, per runtime artifact.
 *
 * `required` is the exact JBR version MPS names. Each candidate artifact gets
 * that version when the repository has it (`exact`), otherwise the oldest
 * build of the same Java version that is newer (`exact: false`), otherwise
 * nothing (`v: null`). Spellings are compared by value, so `11.0.12-b1504.28`
 * matches `11_0_12-b1504.28`.
 *
 * `available` maps an artifact slug to its version list.
 */
export function matchRuntime(required, available) {
  const java = lineOf(required, 'java');
  const artifacts = {};
  for (const [slug, versions] of Object.entries(available)) {
    const exact = versions.find((v) => v === required) ??
      versions.find((v) => compareVersions(v, required) === 0);
    if (exact) {
      artifacts[slug] = { v: exact, exact: true };
      continue;
    }
    const newer = versions
      .filter((v) => lineOf(v, 'java') === java && compareVersions(v, required) > 0)
      .sort(compareVersions)[0];
    artifacts[slug] = { v: newer ?? null, exact: false };
  }
  return artifacts;
}

export function mavenCoordinate(library, version) {
  return `${library.groupId}:${library.artifactId}:${version}`;
}

/* ------------------------------------------------------------ dependencies */

function firstTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`));
  return match ? match[1] : null;
}

/**
 * Direct `<dependencies>` of a POM as `{ groupId, artifactId, version }`.
 *
 * Plugin dependencies (`<build>`), `<dependencyManagement>` and `<exclusions>`
 * also contain groupId/artifactId pairs, so they are cut out before matching.
 * `${property}` versions are resolved against the POM's own `<properties>`.
 */
export function parsePomDependencies(xmlText) {
  const xml = xmlText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<build>[\s\S]*?<\/build>/g, '')
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
    .replace(/<exclusions>[\s\S]*?<\/exclusions>/g, '');

  const properties = new Map();
  const propertiesBlock = xml.match(/<properties>([\s\S]*?)<\/properties>/);
  if (propertiesBlock) {
    for (const [, key, value] of propertiesBlock[1].matchAll(/<([\w.\-]+)>\s*([^<]*?)\s*<\/\1>/g)) {
      properties.set(key, value);
    }
  }
  const expand = (value) =>
    value?.replace(/\$\{([^}]+)\}/g, (whole, key) => properties.get(key) ?? whole) ?? null;

  const dependencies = [];
  for (const [, body] of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const groupId = firstTag(body, 'groupId');
    const artifactId = firstTag(body, 'artifactId');
    if (!groupId || !artifactId) continue;
    dependencies.push({ groupId, artifactId, version: expand(firstTag(body, 'version')) });
  }
  return dependencies;
}

/**
 * Everything one library version needs, transitively, treating every POM
 * version as a minimum.
 *
 * `depsOf(slug, version)` returns `[[depSlug, depVersion], ...]`, or
 * null/undefined when the POM is unknown. When two paths require the same
 * library, the higher version wins, and only that version's own dependencies
 * count -- so the set is recomputed until it stops changing.
 *
 * Returns `{ required: [{ slug, v, via }], unknown: [{ slug, v }] }`, where
 * `via` is the slug path from the root to the requirement (root excluded).
 */
export async function resolveRequirements(root, depsOf) {
  const seed = () => new Map([[root.slug, { v: root.v, by: null }]]);
  let chosen = seed();
  let unknown = [];

  for (let round = 0; round < 32; round++) {
    const next = seed();
    unknown = [];
    for (const [slug, { v }] of chosen) {
      const deps = await depsOf(slug, v);
      if (!deps) {
        unknown.push({ slug, v });
        continue;
      }
      for (const [depSlug, depVersion] of deps) {
        if (depSlug === root.slug) continue;
        const current = next.get(depSlug);
        if (!current || compareVersions(depVersion, current.v) > 0) {
          next.set(depSlug, { v: depVersion, by: slug });
        }
      }
    }
    const settled = next.size === chosen.size &&
      [...next].every(([slug, entry]) => chosen.get(slug)?.v === entry.v && chosen.get(slug)?.by === entry.by);
    chosen = next;
    if (settled) break;
  }

  const via = (slug) => {
    const path = [];
    for (let at = slug; at && at !== root.slug && path.length <= chosen.size; at = chosen.get(at)?.by) {
      path.unshift(at);
    }
    return path;
  };

  const required = [...chosen]
    .filter(([slug]) => slug !== root.slug)
    .map(([slug, { v }]) => ({ slug, v, via: via(slug) }));
  return { required, unknown };
}
