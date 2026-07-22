import { createHash } from "node:crypto";

export const PRODUCTION_CONFIG_PATH = "config/experiment.production.json";
export const SCREEN_PILOT_CONFIG_PATH = "config/experiment.screen-pilot.json";

const SOURCE_TREE_HASH_DOMAIN = "sechack-production-source-tree-v1\0";
const PRODUCTION_CONFIG_PATH_BYTES = Buffer.from(PRODUCTION_CONFIG_PATH, "utf8");

/**
 * Hashes a `git ls-tree -r -z --full-tree` byte stream using the production
 * release provenance definition. The exact production config is the sole
 * excluded path so evidence can be written there without making the digest
 * self-referential. Every other tracked path, including the fixed screen-pilot
 * config and similarly named files, remains covered.
 */
export function hashProductionSourceTreeListing(tree: Buffer): string {
  const hash = createHash("sha256").update(SOURCE_TREE_HASH_DOMAIN, "utf8");
  let cursor = 0;
  let includedEntries = 0;
  while (cursor < tree.byteLength) {
    const terminator = tree.indexOf(0, cursor);
    if (terminator < 0) {
      throw new Error("Git returned a malformed tracked source tree.");
    }
    const record = tree.subarray(cursor, terminator);
    const pathSeparator = record.indexOf(0x09);
    if (pathSeparator < 1 || pathSeparator === record.byteLength - 1) {
      throw new Error("Git returned a malformed tracked source tree entry.");
    }
    const path = record.subarray(pathSeparator + 1);
    if (!path.equals(PRODUCTION_CONFIG_PATH_BYTES)) {
      const frame = Buffer.allocUnsafe(4);
      frame.writeUInt32BE(record.byteLength);
      hash.update(frame).update(record);
      includedEntries += 1;
    }
    cursor = terminator + 1;
  }
  const countFrame = Buffer.allocUnsafe(4);
  countFrame.writeUInt32BE(includedEntries);
  return hash.update(countFrame).digest("hex");
}
