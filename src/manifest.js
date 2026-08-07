import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MANIFEST_FILE = ".loop-development-manifest.json";

export function emptyManifest() {
  return {
    version: null,
    installedAt: null,
    files: [],
    configFile: null,
    configAdded: [],
    configManaged: [],
    configRemoved: []
  };
}

export async function loadManifest(configDir) {
  try {
    const raw = await readFile(join(configDir, MANIFEST_FILE), "utf8");
    return { ...emptyManifest(), ...JSON.parse(raw) };
  } catch {
    return emptyManifest();
  }
}

export async function saveManifest(configDir, manifest) {
  await writeFile(
    join(configDir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
}
