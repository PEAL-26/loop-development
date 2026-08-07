import { readdir } from "node:fs/promises";

export async function countMdFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countMdFiles(`${dir}/${entry.name}`);
    else if (entry.name.endsWith(".md")) count += 1;
  }
  return count;
}
