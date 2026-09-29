/**
 * Single source of truth for this project's identity.
 *
 * WHY THIS EXISTS: the Worker's public URL used to be hard-coded in four places
 * (the refresh workflow, the DevTools snippet, and two tests) and its name in
 * eight more. Moving to a different Cloudflare account changes the URL, because
 * the `*.workers.dev` subdomain belongs to the account — so every one of those
 * copies would have to be found and edited by hand, and a missed one fails
 * silently: the tests keep passing against the old deployment while the workflow
 * polls a URL that no longer exists.
 *
 * Now `project.json` is the only place these values live. `scripts/deploy.mjs`
 * writes the real URL back after a successful deploy, and everything else reads
 * it from here.
 *
 *   import { loadProject, saveProject, sourceOf } from './lib/project.mjs';
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const PROJECT_FILE = path.join(ROOT, 'project.json');

const DEFAULTS = {
  sourceId: 'mcp-zh',
  sourceName: 'MCP 中文源',
  workerName: 'mcp-zh',
  databaseName: 'mcp-zh',
  publicUrl: null,
  accountId: null,
  deployedAt: null,
};

/** @returns {typeof DEFAULTS} */
export function loadProject() {
  if (!fs.existsSync(PROJECT_FILE)) return { ...DEFAULTS };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`project.json is not valid JSON: ${e.message}`);
  }
  const merged = { ...DEFAULTS, ...parsed };
  // The host only accepts ids matching this pattern, and a bad one means the
  // source is silently dropped by the market rather than reported.
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(merged.sourceId)) {
    throw new Error(`project.json sourceId "${merged.sourceId}" does not match ^[a-z][a-z0-9_-]{0,63}$`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(merged.workerName)) {
    throw new Error(`project.json workerName "${merged.workerName}" is not a valid Workers name`);
  }
  return merged;
}

export function saveProject(next) {
  const current = loadProject();
  fs.writeFileSync(PROJECT_FILE, `${JSON.stringify({ ...current, ...next }, null, 2)}\n`, 'utf8');
}

/** The `/servers` endpoint, or null when the project has never been deployed. */
export function sourceUrl(project = loadProject()) {
  if (!project.publicUrl) return null;
  return `${String(project.publicUrl).replace(/\/+$/, '')}/servers`;
}

/**
 * The source record the market stores. Written by `scripts/make-snippet.mjs`
 * and validated against the host's own sanitizeMarketSources() in
 * test/source-order.js.
 */
export function sourceRecord(project = loadProject()) {
  const url = sourceUrl(project);
  return {
    id: project.sourceId,
    name: project.sourceName,
    url: url ?? `https://${project.workerName}.<your-subdomain>.workers.dev/servers`,
    kind: 'registry',
  };
}

/** The builtin official source, which must be preserved verbatim and kept last. */
export const OFFICIAL_SOURCE = {
  id: 'official',
  name: 'Official registry',
  url: 'https://registry.modelcontextprotocol.io/v0/servers',
  kind: 'registry',
  builtin: true,
};
