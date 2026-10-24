import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  catalog as validateCatalog,
  manifest as validateManifest,
  entries,
  array,
  LIMITS,
} from "../../client/src/rendering/stream-validation.js";
import { nearestSavedArrival } from "../../client/src/world/field-arrival.js";
import { animationId } from "../../shared/motion-schema.js";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_MAPS = 128;
const MAX_RULE_FILES = 4096;
const MAX_RULE_BYTES = 64 * 1024 * 1024;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Refuse unsupported life actions at map admission, before any field tick uses them. */
function validateLifeAnimations(manifest) {
  for (const [, template] of entries(
    manifest.life.templates,
    LIMITS.entities,
  )) {
    animationId(template.defaultAction);
    for (const [action] of entries(template.actions, LIMITS.actions)) {
      animationId(action);
    }
    for (const action of array(
      template.speech?.actions ?? [],
      LIMITS.actions,
    )) {
      animationId(action.action);
    }
  }
}

/** Hash the exact server/shared rule implementation, including reused client kernels. */
export async function rulesIdentity(assetBuildId) {
  const paths = [];
  for (const [directory, pattern] of [
    ["server/src", "**/*.js"],
    ["infra/sql", "*.sql"],
    ["shared", "**/*.js"],
    ["client/src", "**/*.js"],
    ["content/src", "**/*.js"],
    ["content", "package.json"],
    ["client/tools", "validation-png.js"],
  ]) {
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({
      cwd: resolve(REPOSITORY, directory),
      onlyFiles: true,
    })) {
      if (paths.length >= MAX_RULE_FILES) {
        throw new Error("Rules file capacity exceeded");
      }
      paths.push(`${directory}/${path}`);
    }
  }
  paths.sort();
  const hash = createHash("sha256").update(
    `openms-rules-v1\0${assetBuildId}\0`,
  );
  let total = 0;
  for (const path of paths) {
    const file = Bun.file(resolve(REPOSITORY, path));
    if (file.size > MAX_RULE_BYTES - total) {
      throw new Error("Rules byte capacity exceeded");
    }
    const bytes = await file.arrayBuffer();
    total += bytes.byteLength;
    if (total > MAX_RULE_BYTES) throw new Error("Rules byte capacity exceeded");
    hash.update(`${path}\0${bytes.byteLength}\0`);
    hash.update(new Uint8Array(bytes));
  }
  return hash.digest("hex");
}

/** Original generated content is admitted by size, SHA-256 and canonical containment. */
export class OriginalContent {
  constructor(root) {
    this.root = root;
    this.maps = new Map();
    this.pendingMaps = new Map();
  }

  async json(descriptor) {
    if (
      !descriptor ||
      !/^\/generated\/(maps|references|bundles|regions)\/[a-f0-9]{64}\.json$/.test(
        descriptor.url,
      )
    ) {
      throw new Error("Invalid content descriptor");
    }
    if (
      !Number.isSafeInteger(descriptor.bytes) ||
      descriptor.bytes < 1 ||
      descriptor.bytes > MAX_JSON_BYTES
    ) {
      throw new Error("Content byte limit exceeded");
    }
    if (!/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
      throw new Error("Invalid content hash");
    }
    const filename = await realpath(
      resolve(this.root, descriptor.url.slice("/generated/".length)),
    );
    if (!filename.startsWith(this.root + sep)) {
      throw new Error("Content escaped generated root");
    }
    const file = Bun.file(filename);
    if (file.size !== descriptor.bytes) {
      throw new Error("Content length mismatch");
    }
    const bytes = await file.arrayBuffer();
    if (
      bytes.byteLength !== descriptor.bytes ||
      digest(new Uint8Array(bytes)) !== descriptor.sha256
    ) {
      throw new Error("Content integrity mismatch");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  async map(value) {
    if (
      !Number.isSafeInteger(Number(value)) ||
      !/^\d{1,9}$/.test(String(value))
    ) {
      throw new Error("Invalid map identity");
    }
    const id = String(Number(value)).padStart(9, "0");
    const cached = this.maps.get(id);
    if (cached) {
      this.maps.delete(id);
      this.maps.set(id, cached);
      return cached;
    }
    if (this.pendingMaps.has(id)) return this.pendingMaps.get(id);
    if (this.maps.size + this.pendingMaps.size >= MAX_CACHED_MAPS) {
      const oldest = this.maps.keys().next();
      if (oldest.done) {
        throw new Error("Field content capacity exceeded");
      }
      // Existing field owners retain their immutable manifest; future loads still verify its hash.
      this.maps.delete(oldest.value);
    }
    const pending = this.loadMap(id);
    this.pendingMaps.set(id, pending);
    try {
      return await pending;
    } finally {
      this.pendingMaps.delete(id);
    }
  }

  async loadMap(id) {
    const descriptor = this.catalog.maps[id];
    if (!descriptor) throw new Error("Map is not in the admitted catalog");
    const manifest = validateManifest(await this.json(descriptor));
    if (manifest.id !== id) throw new Error("Map descriptor identity mismatch");
    validateLifeAnimations(manifest);
    nearestSavedArrival(manifest, { x: 0, y: 0, facing: 1 });
    this.maps.set(id, manifest);
    return manifest;
  }
}

/** Admit the extracted catalog by size, hash and schema. Callers compose their own runtime use. */
export async function openOriginalContent(options = {}) {
  const root = await realpath(
    options.root ?? resolve(REPOSITORY, "client/public/generated"),
  );
  const content = new OriginalContent(root);
  const file = Bun.file(resolve(root, "catalog.json"));
  if (file.size < 1 || file.size > MAX_JSON_BYTES) {
    throw new Error("Catalog byte limit exceeded");
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new Error("Catalog byte limit exceeded");
  }
  content.catalogHash = digest(new Uint8Array(bytes));
  content.catalog = validateCatalog(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  content.assetBuildId = content.catalog.buildId;
  content.rulesHash = await rulesIdentity(content.assetBuildId);
  content.items = content.catalog.ui.items;
  return content;
}
