#!/usr/bin/env node
/**
 * Builds the monthly release artifacts from the data already in the repo.
 *
 *   mps-library-versions-<YYYY-MM>.json   one file, every library, every version
 *   RELEASE_NOTES.md                       latest version per release line
 *
 * Does not hit the network -- it reads versions.json and data/*.json.
 *
 * Usage: node scripts/make-bundle.mjs <output-dir>
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMarker, isRuntime, lineLabel } from '../versions-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = process.argv[2] ?? ROOT;

const summary = JSON.parse(await readFile(join(ROOT, 'versions.json'), 'utf8'));

// The mps-jbr marker is plumbing; its content ships as data/deps/mps-jbr.json.
const libraries = await Promise.all(
  summary.libraries.filter((library) => !isMarker(library)).map(async (library) => {
    const full = JSON.parse(await readFile(join(ROOT, 'data', `${library.slug}.json`), 'utf8'));
    return {
      groupId: library.groupId,
      artifactId: library.artifactId,
      metadataUrl: library.metadataUrl,
      ...(library.kind && { kind: library.kind }),
      ok: library.ok,
      total: full.total,
      released: full.released,
      stable: full.stable,
      preRelease: full.preRelease,
      branchCount: full.branchCount,
      lines: full.lines,
      branchBuilds: full.branchBuilds,
    };
  }),
);

const now = new Date();
const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

const bundle = {
  period,
  releasedAt: now.toISOString(),
  dataGeneratedAt: summary.generatedAt,
  source: 'https://artifacts.itemis.cloud/repository/maven-mps/',
  libraries,
};

const bundleName = `mps-library-versions-${period}.json`;
await writeFile(join(outputDir, bundleName), `${JSON.stringify(bundle, null, 2)}\n`);

// Release notes: one table per release line, as that is how the versions are
// actually consumed (you pin a whole set against one MPS version).
const mpsLibraries = libraries.filter((library) => !isRuntime(library));
const lineKeys = [...new Set(mpsLibraries.flatMap((library) => library.lines.map((line) => line.line)))];
lineKeys.sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]) || Number(b.split('.')[1]) - Number(a.split('.')[1]));

let notes = `Snapshot of the latest MPS library versions on ${now.toISOString().slice(0, 10)}.\n\n`;
notes += `Data generated: ${summary.generatedAt}\n\n`;
notes += `Full machine-readable list: \`${bundleName}\` (attached).\n\n`;

for (const line of lineKeys.slice(0, 8)) {
  const rows = mpsLibraries
    .map((library) => ({ library, entry: library.lines.find((candidate) => candidate.line === line) }))
    .filter((row) => row.entry);
  if (rows.length === 0) continue;
  notes += `### MPS ${lineLabel(line)}\n\n| Library | Latest |\n| --- | --- |\n`;
  for (const { library, entry } of rows) {
    const flag = entry.latestIsPreRelease ? ' _(pre-release)_' : '';
    notes += `| \`${library.groupId}:${library.artifactId}\` | \`${entry.latest}\`${flag} |\n`;
  }
  notes += '\n';
}

if (lineKeys.length > 8) {
  notes += `_${lineKeys.length - 8} older release lines omitted -- see the attached JSON._\n`;
}

const runtimes = libraries.filter(isRuntime);
if (runtimes.length) {
  notes += `\n### JetBrains Runtime\n\n| Artifact | Java | Latest |\n| --- | --- | --- |\n`;
  for (const library of runtimes) {
    for (const entry of library.lines) {
      notes += `| \`${library.groupId}:${library.artifactId}\` | ${entry.line} | \`${entry.latest}\` |\n`;
    }
  }
}

await writeFile(join(outputDir, 'RELEASE_NOTES.md'), notes);

process.stdout.write(`bundle=${bundleName}\nperiod=${period}\n`);
