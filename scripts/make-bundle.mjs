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

import { lineLabel } from '../versions-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = process.argv[2] ?? ROOT;

const summary = JSON.parse(await readFile(join(ROOT, 'versions.json'), 'utf8'));

const libraries = await Promise.all(
  summary.libraries.map(async (library) => {
    const full = JSON.parse(await readFile(join(ROOT, 'data', `${library.slug}.json`), 'utf8'));
    return {
      groupId: library.groupId,
      artifactId: library.artifactId,
      metadataUrl: library.metadataUrl,
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
const lineKeys = [...new Set(libraries.flatMap((library) => library.lines.map((line) => line.line)))];
lineKeys.sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]) || Number(b.split('.')[1]) - Number(a.split('.')[1]));

let notes = `Snapshot of the latest MPS library versions on ${now.toISOString().slice(0, 10)}.\n\n`;
notes += `Data generated: ${summary.generatedAt}\n\n`;
notes += `Full machine-readable list: \`${bundleName}\` (attached).\n\n`;

for (const line of lineKeys.slice(0, 8)) {
  const rows = libraries
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

await writeFile(join(outputDir, 'RELEASE_NOTES.md'), notes);

process.stdout.write(`bundle=${bundleName}\nperiod=${period}\n`);
