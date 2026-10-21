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
 *   tool      build tooling (mps-gradle-plugin, mps-build-backends), versioned
 *             independently of MPS, grouped by major version
 *   marker    tracked for its POM dependencies only, never shown
 */
export const isRuntime = (library) => library?.kind === 'runtime';
export const isMarker = (library) => library?.kind === 'marker';
export const isTool = (library) => library?.kind === 'tool';
/** Grouped by MPS release line: shown on the board and in the line picker. */
export const isMpsLibrary = (library) => !library?.kind;

/** How a library's versions are grouped into lines. */
export function lineSchemeOf(library) {
  if (library?.lineScheme) return library.lineScheme;
  return isRuntime(library) ? 'java' : 'mps';
}

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
 * MPS libraries, the Java version for runtime artifacts, `N.x` for tooling
 * grouped by major version.
 */
export function lineOf(version, scheme = 'mps') {
  if (scheme === 'java') return version.match(JAVA_LINE_RE)?.[1] ?? null;
  if (scheme === 'major') {
    const major = version.match(/^(\d+)\./)?.[1];
    return major ? `${major}.x` : null;
  }
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
export function buildLibraryData(rawVersions, { lineScheme = 'mps', discouraged = {} } = {}) {
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
        // Configured per library (libraries.json `discouraged`): a line that
        // exists but should not be used, e.g. mps-gradle-plugin 2.x.
        ...(discouraged[line] && { discouraged: discouraged[line] }),
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

/**
 * GitHub tree of the library's repository as it was at this version; null
 * when the version has no known ref.
 *
 * - JBR: release tag `jbr-release-<version without "-">`. Older 8u/11
 *   builds (`11_0_10-b1145.96`) follow no single tag scheme and get none.
 * - MPS: the version is the tag (`2026.1`, `2026.1.1`); pre-releases and
 *   build numbers (`263.6259.45`) are not tagged.
 * - everything else: the commit the build carries as its last segment
 *   (`2026.1.3688.0c1ad7a`, SNAPSHOTs and branch builds alike).
 */
export function sourceUrl(library, version) {
  if (!library.repo) return null;
  let ref = null;
  if (isRuntime(library)) {
    if (/^\d+(\.\d+)+-b[\d.]+$/.test(version)) ref = `jbr-release-${version.replace('-', '')}`;
  } else if (library.repo === 'JetBrains/MPS') {
    if (/^\d{4}\.\d+(\.\d+)?$/.test(version)) ref = version;
  } else {
    ref = version.replace(/-SNAPSHOT$/i, '').match(/\.([0-9a-f]{7,40})$/)?.[1] ?? null;
  }
  return ref ? `https://github.com/${library.repo}/tree/${encodeURIComponent(ref)}` : null;
}

/** Repository front page and changelog of a library, each null if unknown. */
export function repoLinks(library) {
  return {
    repo: library.repo ? `https://github.com/${library.repo}` : null,
    changelog: library.changelog ?? null,
  };
}

/**
 * The line to recommend: the newest line that is not discouraged (falling
 * back to the newest overall). Lines come newest first.
 */
export function recommendedLine(lines) {
  return lines.find((line) => !line.discouraged && !isDevelopmentLine(line.line)) ?? lines[0] ?? null;
}

/**
 * MPS line of a version string from a tested-against list: `2024.1.6` ->
 * `2024.1`; a prerelease build number `263.6259.45` -> `2026.3` (flagged).
 */
export function mpsLineOfTested(version) {
  const release = version.match(/^(\d{4})\.(\d+)/);
  if (release) return { line: `${release[1]}.${release[2]}`, pre: false };
  const build = version.match(/^(\d{2})(\d)\./);
  if (build) return { line: `20${build[1]}.${build[2]}`, pre: true };
  return null;
}

/* --------------------------------------------------- gradle plugin contract */

/** Whether a version satisfies a Gradle/Maven version: `[1.26,2.0)`, `1.+`, `1.2`. */
export function inVersionRange(version, range) {
  if (!range) return false;
  const interval = range.match(/^([[(])\s*([^,]*)\s*,\s*([^\])]*)\s*([\])])$/);
  if (interval) {
    const [, open, low, high, close] = interval;
    if (low) {
      const order = compareVersions(version, low);
      if (order < 0 || (order === 0 && open === '(')) return false;
    }
    if (high) {
      const order = compareVersions(version, high);
      if (order > 0 || (order === 0 && close === ')')) return false;
    }
    return true;
  }
  if (range.endsWith('+')) return version.startsWith(range.slice(0, -1));
  return compareVersions(version, range) === 0;
}

/**
 * The "tested against" contract of one mps-gradle-plugin version for one MPS
 * line, from scripts/gradle-plugin-compat.json (see docs/gradle-plugin-compat.md).
 *
 * The plugin runs the launcher it pins (POM) and the newest backends inside
 * its range (resolved by Gradle at build time, so this moves as backends are
 * released). A line counts as tested when both of those backend releases list
 * a release of it; a prerelease build alone is reported as `pre`.
 *
 * `available` maps a backend artifact to its released versions, newest first.
 */
export function pluginContract(compat, pluginVersion, available, mpsLine) {
  const facts = compat?.extracted?.plugin?.[pluginVersion];
  if (!facts) return null;
  const testedOf = (artifact, version) => {
    const commit = compat.extracted.backends?.[artifact]?.[version];
    return commit ? (compat.extracted.testedMps?.[commit] ?? null) : null;
  };
  const resolved = facts.backendsRange
    ? (available.modelcheck ?? []).find((v) => inVersionRange(v, facts.backendsRange)) ?? null
    : null;
  const sources = [];
  if (facts.launcher) sources.push({ artifact: 'launcher', version: facts.launcher, tested: testedOf('launcher', facts.launcher) });
  if (resolved) sources.push({ artifact: 'modelcheck', version: resolved, tested: testedOf('modelcheck', resolved) });

  const coverage = (tested) => {
    const hits = (tested ?? []).map(mpsLineOfTested).filter((hit) => hit?.line === mpsLine);
    if (hits.some((hit) => !hit.pre)) return 'tested';
    return hits.length ? 'pre' : 'untested';
  };
  const levels = sources.map((source) => coverage(source.tested));
  const status = !sources.length || sources.some((source) => !source.tested)
    ? 'unknown'
    : levels.includes('untested') ? 'untested' : levels.includes('pre') ? 'pre' : 'tested';

  // Curated minimums apply to the named line and every later one.
  const curated = compat.curated ?? {};
  const minimum = (curated.pluginMinimumForMps ?? [])
    .filter((entry) => compareVersions(mpsLine, entry.mps) >= 0)
    .sort((a, b) => compareVersions(b.plugin, a.plugin))[0] ?? null;
  const dropped = (curated.pluginMpsDropped ?? [])
    .find((entry) => compareVersions(mpsLine, entry.mps) <= 0 && compareVersions(pluginVersion, entry.plugin) >= 0) ?? null;
  const gradleMin = (curated.pluginGradle ?? [])
    .filter((entry) => entry.gradleMin && compareVersions(pluginVersion, entry.plugin) >= 0)
    .sort((a, b) => compareVersions(b.plugin, a.plugin))[0] ?? null;

  return {
    ...facts,
    resolvedBackends: resolved,
    sources,
    status,
    minimum,
    belowMinimum: Boolean(minimum && compareVersions(pluginVersion, minimum.plugin) < 0),
    dropped,
    gradleMin,
  };
}

/* ------------------------------------------------------------------- dates */

/**
 * Calendar day `YYYY-MM-DD` of a publication timestamp in the local time
 * zone, so it matches the time shown. A bare date is a day already.
 */
export function publishedDay(value) {
  if (!value || value.length === 10) return value ?? null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whether a publication timestamp falls on a day within [from, to]
 * (`YYYY-MM-DD`, local); either bound may be empty. Same-format ISO dates
 * compare correctly as strings.
 */
export function inDateRange(value, from, to) {
  if (!from && !to) return true;
  const day = publishedDay(value);
  if (!day) return false;
  return (!from || day >= from) && (!to || day <= to);
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
