#!/usr/bin/env node
/**
 * Fetches maven-metadata.xml for every configured library and writes:
 *
 *   versions.json              summary: latest version per release line (small, loaded on page load)
 *   data/<slug>.json           full version list per library (loaded on demand)
 *
 * Runs on a GitHub Actions runner, so it talks to the repository directly --
 * no CORS, no proxy.
 *
 * Files are only rewritten when the version data actually changed; the
 * `generatedAt` timestamp alone never produces a commit. That keeps
 * `git log versions.json` readable as a changelog of MPS library releases.
 *
 * Exit code 0 on success (changed or not), 1 if every library failed.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMetadata, buildLibraryData, slugFor } from '../versions-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARY_FILE = join(ROOT, 'versions.json');
const DATA_DIR = join(ROOT, 'data');

const TIMEOUT_MS = 20000;
const ATTEMPTS = 3;

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchMetadata(library) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(library.metadataUrl, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/xml, text/xml, */*' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const versions = parseMetadata(text);
      if (versions.length === 0) throw new Error('no <version> entries in metadata');
      return versions;
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  throw lastError;
}

/** Strip volatile fields so two runs can be compared for real changes. */
function stable(payload) {
  const { generatedAt, fetchedAt, ...rest } = payload;
  return JSON.stringify(rest);
}

async function main() {
  const libraries = JSON.parse(await readFile(join(ROOT, 'scripts', 'libraries.json'), 'utf8'));
  const previousSummary = await readJsonIfExists(SUMMARY_FILE);

  const results = await Promise.all(
    libraries.map(async (library) => {
      const slug = slugFor(library);
      try {
        const rawVersions = await fetchMetadata(library);
        const data = buildLibraryData(rawVersions);
        process.stderr.write(
          `ok    ${library.groupId}:${library.artifactId} -- ${data.total} versions, ${data.lines.length} lines\n`,
        );
        return { library, slug, ok: true, data };
      } catch (error) {
        process.stderr.write(
          `FAIL  ${library.groupId}:${library.artifactId} -- ${error.message}\n`,
        );
        return { library, slug, ok: false, error: error.message };
      }
    }),
  );

  if (results.every((result) => !result.ok)) {
    process.stderr.write('\nEvery library failed -- leaving existing data untouched.\n');
    process.exitCode = 1;
    return;
  }

  const generatedAt = new Date().toISOString();
  const summaryLibraries = [];
  const dataFiles = [];

  for (const result of results) {
    const { library, slug } = result;
    const dataPath = join(DATA_DIR, `${slug}.json`);

    if (!result.ok) {
      // Keep whatever we had rather than blanking the entry, and say so.
      const previous = previousSummary?.libraries?.find((entry) => entry.slug === slug);
      summaryLibraries.push({
        ...(previous ?? { ...library, slug, lines: [], total: 0, released: 0, stable: 0, preRelease: 0, branchCount: 0 }),
        ...library,
        slug,
        ok: false,
        error: result.error,
        staleSince: previous?.staleSince ?? generatedAt,
      });
      continue;
    }

    const { data } = result;
    summaryLibraries.push({
      ...library,
      slug,
      ok: true,
      total: data.total,
      released: data.released,
      stable: data.stable,
      preRelease: data.preRelease,
      branchCount: data.branchCount,
      branches: data.branches,
      dataFile: `data/${slug}.json`,
      // Summary carries only the latest per line; the full lists live in the
      // per-library data file so the initial page load stays small.
      lines: data.lines.map(({ line, latest, latestIsPreRelease, total, stable: stableCount }) => ({
        line,
        latest,
        latestIsPreRelease,
        total,
        stable: stableCount,
      })),
    });

    dataFiles.push({
      path: dataPath,
      payload: {
        ...library,
        slug,
        generatedAt,
        total: data.total,
        released: data.released,
        stable: data.stable,
        preRelease: data.preRelease,
        branchCount: data.branchCount,
        branches: data.branches,
        lines: data.lines,
        branchBuilds: data.branchBuilds,
      },
    });
  }

  const summary = { generatedAt, libraries: summaryLibraries };

  let changed = !previousSummary || stable(previousSummary) !== stable(summary);
  for (const file of dataFiles) {
    const previous = await readJsonIfExists(file.path);
    if (!previous || stable(previous) !== stable(file.payload)) changed = true;
  }

  if (!changed) {
    process.stdout.write('changed=false\n');
    process.stderr.write('\nNo version changes -- nothing written.\n');
    return;
  }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
  for (const file of dataFiles) {
    await writeFile(file.path, `${JSON.stringify(file.payload, null, 2)}\n`);
  }

  process.stdout.write('changed=true\n');
  process.stderr.write(`\nWrote versions.json and ${dataFiles.length} data files.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
