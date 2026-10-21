#!/usr/bin/env node
/**
 * Checks the assumptions the extractors and the page rely on against the
 * current data, so new versions and deprecations that need a human (or agent)
 * decision are noticed instead of being mis-extracted silently.
 *
 * Writes data/assumptions-report.md (stable content: no timestamps, so it only
 * changes when the findings do) and appends it to the GitHub step summary when
 * run in Actions. Exit code 0 unless --strict and an error was found.
 *
 * What each check means and how to resolve it: docs/reassessment.md.
 *
 * Usage: node scripts/check-assumptions.mjs [--strict]
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareVersions,
  isDevelopmentLine,
  isMpsLibrary,
  isMarker,
  isTool,
  lineSchemeOf,
  lineOf,
  branchOf,
  recommendedLine,
  inVersionRange,
} from '../versions-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'data', 'assumptions-report.md');
const DAY = 24 * 60 * 60 * 1000;
/** A new MPS release may take this long to get its mps-jbr marker. */
const MARKER_GRACE_DAYS = 14;
/** Releases before this have no marker; see fetch-deps.mjs MARKER_SINCE. */
const MARKER_SINCE = '2023.3.1';

const findings = [];
const add = (level, check, message) => findings.push({ level, check, message });

async function readJson(path) {
  return existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : null;
}

const releasesOf = (data) => data.lines.flatMap((line) => line.versions.map((entry) => ({ ...entry, line: line.line })));
const daysSince = (date) => (Date.now() - Date.parse(date)) / DAY;

async function main() {
  const strict = process.argv.includes('--strict');
  const summary = await readJson(join(ROOT, 'versions.json'));
  if (!summary) throw new Error('versions.json missing -- run fetch-versions.mjs first');
  const data = new Map();
  for (const library of summary.libraries) {
    data.set(library.slug, await readJson(join(ROOT, 'data', `${library.slug}.json`)));
  }

  for (const library of summary.libraries) {
    const full = data.get(library.slug);
    const name = `${library.groupId}:${library.artifactId}`;
    if (!library.ok) add('error', 'fetch', `${name}: metadata fetch failed (${library.error ?? 'unknown'}), showing stale data`);
    if (!full || isMarker(library)) continue;

    // 1. Version shapes the line scheme does not understand.
    const scheme = lineSchemeOf(library);
    const raw = [...releasesOf(full).map((e) => e.v), ...(full.branchBuilds ?? []).map((e) => e.v)];
    const unparsed = raw.filter((v) => branchOf(v) === null && lineOf(v, scheme) === null);
    if (unparsed.length) {
      add('warn', 'version-shape', `${name}: ${unparsed.length} version(s) fit no ${scheme} line and are dropped, e.g. ${unparsed.slice(0, 3).join(', ')}`);
    }

    // 2. A line ranked above the one holding the newest upload: abandoned?
    const dated = releasesOf(full).filter((e) => e.d && !e.pre && !isDevelopmentLine(e.line));
    const newest = dated.sort((a, b) => b.d.localeCompare(a.d))[0];
    if (newest && !isMpsLibrary(library)) {
      const recommended = recommendedLine(full.lines);
      for (const line of full.lines) {
        if (line.discouraged || isDevelopmentLine(line.line)) continue;
        if (compareVersions(line.line, newest.line) > 0) {
          add('error', 'abandoned-line', `${name}: line ${line.line} ranks above ${newest.line}, but the newest upload (${newest.v}, ${newest.d.slice(0, 10)}) is in ${newest.line}. Mark ${line.line} as discouraged in scripts/libraries.json if it is abandoned.`);
        }
      }
      if (recommended && recommended.line !== newest.line && !recommended.discouraged) {
        add('warn', 'recommended-line', `${name}: recommends ${recommended.line} (${recommended.latest}) but the newest upload is ${newest.v} in ${newest.line}`);
      }
    }
  }

  // 3. Synthetic development lines the page does not know about.
  const mps = data.get('com.jetbrains_mps');
  const newestMps = mps?.lines.map((l) => l.line).filter((l) => !isDevelopmentLine(l)).sort(compareVersions).at(-1);
  for (const library of summary.libraries.filter(isMpsLibrary)) {
    for (const line of data.get(library.slug)?.lines ?? []) {
      if (isDevelopmentLine(line.line) || !newestMps) continue;
      if (Number(line.line.split('.')[0]) > Number(newestMps.split('.')[0]) + 1) {
        add('error', 'development-line', `${library.artifactId}: line ${line.line} is far beyond MPS ${newestMps}; add it to DEVELOPMENT_LINES in versions-lib.js if it is synthetic`);
      }
    }
  }

  // 4. MPS releases without a JBR mapping.
  const runtime = (await readJson(join(ROOT, 'data', 'deps', 'mps-jbr.json')))?.versions ?? {};
  for (const entry of mps ? releasesOf(mps) : []) {
    if (entry.pre || compareVersions(entry.v, MARKER_SINCE) < 0 || runtime[entry.v]) continue;
    if (entry.d && daysSince(entry.d) < MARKER_GRACE_DAYS) continue;
    add('warn', 'mps-jbr', `MPS ${entry.v} (published ${entry.d?.slice(0, 10) ?? 'undated'}) has no JBR mapping: no com.jetbrains.mps:mps-jbr marker for it yet`);
  }

  // 5. Dates and dependencies not fetched yet (informational).
  let undated = 0;
  for (const [slug, full] of data) {
    if (!full || isMarker(summary.libraries.find((l) => l.slug === slug))) continue;
    undated += [...releasesOf(full), ...(full.branchBuilds ?? [])].filter((e) => !e.d).length;
  }
  if (undated) add('info', 'dates', `${undated} version(s) have no publication date yet`);

  // 6. Gradle plugin contract.
  const compat = await readJson(join(ROOT, 'scripts', 'gradle-plugin-compat.json'));
  const plugin = data.get('de.itemis.mps_mps-gradle-plugin');
  if (plugin && !compat) add('error', 'compat', 'scripts/gradle-plugin-compat.json missing: run scripts/extract-gradle-plugin-compat.mjs');
  if (plugin && compat) {
    const line = recommendedLine(plugin.lines);
    // The newest releases: older ones predate some sources (no backend range
    // before 2022-07) and are not what this check is for.
    for (const entry of (line?.versions ?? []).filter((e) => !e.pre).slice(0, 5)) {
      const facts = compat.extracted?.plugin?.[entry.v];
      if (!facts) add('warn', 'compat', `mps-gradle-plugin ${entry.v} is not in the extracted contract: re-run the extractor`);
      else if (!facts.commit) add('info', 'compat', `mps-gradle-plugin ${entry.v}: source commit not found (rebased away?)`);
      else if (!facts.backendsRange || !facts.gradle || !facts.java) {
        add('warn', 'compat', `mps-gradle-plugin ${entry.v}: incomplete facts (range ${facts.backendsRange}, gradle ${facts.gradle}, java ${facts.java}); a source may have moved, see docs/gradle-plugin-compat.md step 2`);
      }
    }
    const modelcheck = data.get('de.itemis.mps.build-backends_modelcheck');
    const latestPlugin = line?.latest;
    const range = compat.extracted?.plugin?.[latestPlugin]?.backendsRange;
    const resolved = range && releasesOf(modelcheck ?? { lines: [] }).map((e) => e.v).find((v) => inVersionRange(v, range));
    const commit = resolved && compat.extracted?.backends?.modelcheck?.[resolved];
    if (resolved && !compat.extracted?.testedMps?.[commit]) {
      add('warn', 'compat', `backends ${resolved} (resolved by plugin ${latestPlugin}) has no tested MPS list: the test matrix may have moved, see docs/gradle-plugin-compat.md step 2`);
    }
    const reviewed = compat.curated?.reviewedUpTo;
    const base = latestPlugin?.split('.').slice(0, 3).join('.');
    if (base && (!reviewed || compareVersions(base, reviewed) > 0)) {
      add('warn', 'compat-curated', `plugin CHANGELOG reviewed up to ${reviewed ?? 'nothing'}, newest release is ${base}: review it, see docs/gradle-plugin-compat.md step 3`);
    }
  }

  // 7. Hard-coded page constants.
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const defaultLine = html.match(/const DEFAULT_LINE = "([^"]+)"/)?.[1];
  const keyLines = [...(html.match(/const KEY_LINES = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (defaultLine && !mps?.lines.some((l) => l.line === defaultLine)) {
    add('error', 'page-constants', `DEFAULT_LINE ${defaultLine} is not an MPS line anymore`);
  }
  if (newestMps && !keyLines.includes(newestMps)) {
    add('info', 'page-constants', `newest MPS line ${newestMps} is not in KEY_LINES (${keyLines.join(', ')})`);
  }

  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level] || a.check.localeCompare(b.check) || a.message.localeCompare(b.message));
  const counts = Object.fromEntries(Object.keys(order).map((level) => [level, findings.filter((f) => f.level === level).length]));
  let report = '# Assumption check\n\n';
  report += 'Generated by `scripts/check-assumptions.mjs`; how to resolve each check: `docs/reassessment.md`.\n\n';
  report += `${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} note(s).\n\n`;
  report += findings.length
    ? `| Level | Check | Finding |\n| --- | --- | --- |\n${findings.map((f) => `| ${f.level} | ${f.check} | ${f.message.replace(/\|/g, '\\|')} |`).join('\n')}\n`
    : 'All assumptions hold.\n';

  const previous = existsSync(REPORT) ? await readFile(REPORT, 'utf8') : null;
  if (previous !== report) await writeFile(REPORT, report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
  process.stdout.write(report);
  if (strict && counts.error) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
