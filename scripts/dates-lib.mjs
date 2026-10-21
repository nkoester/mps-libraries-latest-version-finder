/**
 * Publication dates, kept in data/dates/<slug>.json (version -> UTC timestamp
 * such as 2026-09-17T13:35:08Z, or a bare YYYY-MM-DD from before times were
 * kept; null when the repository has no date for it) and copied into the version
 * data as `d` on every entry and `latestDate` on every line.
 *
 * Shared by fetch-versions.mjs, which applies the cache while it builds, and
 * fetch-dates.mjs, which fills the cache and re-applies it to the files on
 * disk. Both apply it the same way, so neither undoes the other.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function datesPath(root, slug) {
  return join(root, 'data', 'dates', `${slug}.json`);
}

/** version -> timestamp for one library; empty when there is no cache yet. */
export async function readDates(root, slug) {
  const path = datesPath(root, slug);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, 'utf8')).versions ?? {};
  } catch {
    return {};
  }
}

/**
 * Sets `d` on every version entry and `latestDate` on every line, in place.
 * Works on both shapes: full data (lines with `versions`, `branchBuilds`)
 * and the summary (lines with `latest` only). Unknown dates are left out.
 */
export function applyDates(data, dates) {
  const stamp = (entry) => {
    const date = dates[entry.v];
    if (date) entry.d = date;
    else delete entry.d;
    return entry;
  };
  for (const line of data.lines ?? []) {
    line.versions?.forEach(stamp);
    const date = dates[line.latest];
    if (date) line.latestDate = date;
    else delete line.latestDate;
  }
  data.branchBuilds?.forEach(stamp);
  return data;
}
