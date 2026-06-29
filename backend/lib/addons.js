'use strict';

// Addon manifest loading, validation, and dependency resolution.
//
// An addon lives at addons/<id>/addon.json and declares how to install a tool
// either onto the container OS (target: "os") or into the cluster
// (target: "cluster"). This module is pure (only reads the filesystem in
// loadAddonManifests) so it can be unit-tested against fixture directories.

const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9-]+$/;
const VALID_TARGETS = ['os', 'cluster'];

/**
 * Map Node's process.arch to the naming used by tool release artifacts.
 * @returns {string} e.g. "amd64" | "arm64"
 */
function detectArch() {
  switch (process.arch) {
    case 'x64':   return 'amd64';
    case 'arm64': return 'arm64';
    default:      return process.arch;
  }
}

function validateCommands(val, field, errors) {
  if (!Array.isArray(val)) {
    errors.push(`${field} must be an array`);
    return;
  }
  val.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      errors.push(`${field}[${i}] must be an object`);
      return;
    }
    if (typeof c.command !== 'string' || c.command.length === 0) {
      errors.push(`${field}[${i}].command is required`);
    }
    if (c.label != null && typeof c.label !== 'string') {
      errors.push(`${field}[${i}].label must be a string`);
    }
  });
}

/**
 * Structurally validate a raw manifest object. Cross-manifest concerns
 * (dependency existence, cycles) are checked separately via validateGraph /
 * resolveInstallOrder so they can report against the whole catalog.
 *
 * @param {unknown} raw
 * @param {string|null} dirName directory the manifest was loaded from (id must match)
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateManifest(raw, dirName = null) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['manifest is not an object'] };
  }
  const req = (cond, msg) => { if (!cond) errors.push(msg); };

  req(typeof raw.id === 'string' && ID_RE.test(raw.id), 'id must match ^[a-z0-9-]+$');
  if (typeof raw.id === 'string' && dirName != null) {
    req(raw.id === dirName, `id "${raw.id}" must match directory name "${dirName}"`);
  }
  req(typeof raw.name === 'string' && raw.name.length > 0, 'name is required');
  req(typeof raw.description === 'string' && raw.description.length > 0, 'description is required');
  req(typeof raw.category === 'string' && raw.category.length > 0, 'category is required');
  req(VALID_TARGETS.includes(raw.target), `target must be one of: ${VALID_TARGETS.join(', ')}`);
  req(typeof raw.version === 'string' && raw.version.length > 0, 'version is required');
  req(typeof raw.health_command === 'string' && raw.health_command.length > 0, 'health_command is required');

  validateCommands(raw.setup_commands, 'setup_commands', errors);
  validateCommands(raw.teardown_commands, 'teardown_commands', errors);

  if (raw.dependencies != null) {
    if (!Array.isArray(raw.dependencies)) {
      errors.push('dependencies must be an array');
    } else {
      raw.dependencies.forEach((d, i) => {
        if (typeof d !== 'string' || !ID_RE.test(d)) {
          errors.push(`dependencies[${i}] must be a valid addon id`);
        }
      });
    }
  }
  if (raw.arch_support != null && !Array.isArray(raw.arch_support)) {
    errors.push('arch_support must be an array');
  }
  if (raw.logo != null && typeof raw.logo !== 'string') {
    errors.push('logo must be a string (URL)');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Fill in optional fields with defaults and return a frozen, normalized copy.
 * @param {object} raw a manifest that has already passed validateManifest
 */
function normalizeManifest(raw) {
  return Object.freeze({
    id: raw.id,
    name: raw.name,
    description: raw.description,
    category: raw.category,
    icon: raw.icon || '📦',
    logo: typeof raw.logo === 'string' && raw.logo ? raw.logo : null,
    target: raw.target,
    version: raw.version,
    docs_url: raw.docs_url || null,
    est_seconds: typeof raw.est_seconds === 'number' ? raw.est_seconds : 60,
    arch_support: Array.isArray(raw.arch_support) ? [...raw.arch_support] : [],
    dependencies: Array.isArray(raw.dependencies) ? [...raw.dependencies] : [],
    tags: Array.isArray(raw.tags) ? [...raw.tags] : [],
    setup_commands: raw.setup_commands,
    teardown_commands: raw.teardown_commands,
    health_command: raw.health_command
  });
}

/**
 * Load and structurally validate every addon manifest under `dir`.
 * Directories starting with "_" (e.g. _TEMPLATE) or "." are skipped.
 * Invalid manifests are excluded and reported in `errors` — never thrown,
 * so one bad addon can't break the catalog.
 *
 * @param {string} dir addons root directory
 * @returns {{ addons: object[], errors: string[] }}
 */
function loadAddonManifests(dir) {
  const addons = [];
  const errors = [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { addons, errors: [`cannot read addons dir "${dir}": ${e.message}`] };
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('_') || ent.name.startsWith('.')) continue;

    const manifestPath = path.join(dir, ent.name, 'addon.json');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      errors.push(`${ent.name}: cannot read/parse addon.json: ${e.message}`);
      continue;
    }

    const { valid, errors: vErrs } = validateManifest(raw, ent.name);
    if (!valid) {
      errors.push(`${ent.name}: ${vErrs.join('; ')}`);
      continue;
    }
    addons.push(normalizeManifest(raw));
  }

  return { addons, errors };
}

/**
 * @param {object[]} addons
 * @returns {Map<string, object>} id -> manifest
 */
function buildIndex(addons) {
  return new Map(addons.map(a => [a.id, a]));
}

/**
 * Compute the full transitive install order for an addon: the deepest
 * dependencies first, the requested addon last. Deduplicates shared
 * dependencies and detects cycles / unknown ids (throws).
 *
 * @param {string} rootId
 * @param {Map<string, object>} index
 * @returns {string[]} ordered addon ids (leaves first, root last)
 */
function resolveInstallOrder(rootId, index) {
  const order = [];
  const mark = new Map(); // id -> 'visiting' | 'done'

  function visit(id, chain) {
    if (!index.has(id)) {
      const via = chain.length ? ` (required by "${chain[chain.length - 1]}")` : '';
      throw new Error(`unknown addon "${id}"${via}`);
    }
    const m = mark.get(id);
    if (m === 'done') return;
    if (m === 'visiting') {
      throw new Error(`dependency cycle detected: ${[...chain, id].join(' -> ')}`);
    }
    mark.set(id, 'visiting');
    for (const dep of index.get(id).dependencies) {
      visit(dep, [...chain, id]);
    }
    mark.set(id, 'done');
    order.push(id);
  }

  visit(rootId, []);
  return order;
}

/**
 * Direct dependents of an addon — addons that list `id` in their dependencies.
 * Used to block removal of an addon another installed addon still needs.
 * @returns {string[]}
 */
function getDependents(id, addons) {
  return addons.filter(a => a.dependencies.includes(id)).map(a => a.id);
}

/**
 * Validate the whole dependency graph (existence + cycles). Returns one error
 * string per addon whose install order can't be resolved. Used at startup for
 * logging; the catalog still loads so read-only views keep working.
 * @returns {string[]}
 */
function validateGraph(addons) {
  const index = buildIndex(addons);
  const errors = [];
  for (const a of addons) {
    try {
      resolveInstallOrder(a.id, index);
    } catch (e) {
      errors.push(`${a.id}: ${e.message}`);
    }
  }
  return errors;
}

module.exports = {
  ID_RE,
  VALID_TARGETS,
  detectArch,
  validateManifest,
  normalizeManifest,
  loadAddonManifests,
  buildIndex,
  resolveInstallOrder,
  getDependents,
  validateGraph
};
