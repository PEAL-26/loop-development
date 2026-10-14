import { gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const gunzipAsync = promisify(gunzipCb);

// ---------------------------------------------------------------------------
// Leitor de tar — o suficiente para extrair uma subpasta de um tarball do GitHub.
//
// O pacote não tem dependências de runtime (ver `doctor`), por isso isto é
// propositadamente pequeno: cabeçalhos de 512 bytes, campos em octal ASCII (com
// fallback para base-256), e os cabeçalhos estendidos que o `git` emite (pax 'x'
// e GNU 'L'). Não valida checksums — o TLS e a assinatura do GitHub já dão
// essa garantia, e um checksum errado aqui só custaria um bug.
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512;

export const DEFAULT_MAX_ENTRIES = 5000;
export const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;

export class TarError extends Error {}

export async function gunzip(buffer, { maxBytes = DEFAULT_MAX_TOTAL_BYTES } = {}) {
  try {
    return await gunzipAsync(buffer, { maxOutputLength: maxBytes });
  } catch (err) {
    throw new TarError(`não foi possível descomprimir o tarball: ${err.message}`);
  }
}

// Campos numéricos: octal terminado em NUL/espaço, ou base-256 quando o bit
// alto do primeiro byte está ligado (valores grandes em tarballs modernos).
function readNumeric(buf, offset, length) {
  if (offset + length > buf.length) return 0;
  if ((buf[offset] & 0x80) !== 0) {
    let value = 0n;
    for (let i = offset; i < offset + length; i += 1) {
      value = (value << 8n) | BigInt(buf[i] & (i === offset ? 0x7f : 0xff));
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TarError("campo numérico de tar fora de rango");
    return Number(value);
  }
  const text = buf.toString("ascii", offset, offset + length).replace(/\0.*$/, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError(`campo numérico de tar inválido: "${text}"`);
  return parseInt(text, 8);
}

function readString(buf, offset, length) {
  if (offset + length > buf.length) return "";
  return buf.toString("utf8", offset, offset + length).replace(/\0.*$/, "");
}

function isZeroBlock(buf, offset) {
  for (let i = offset; i < offset + BLOCK_SIZE; i += 1) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

// Registos pax: "<len> <chave>=<valor>\n", onde <len> conta o próprio registo.
function parsePax(data) {
  const out = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(data.toString("ascii", pos, space), 10);
    if (!Number.isInteger(len) || len <= 0 || pos + len > data.length) break;
    const record = data.toString("utf8", space + 1, pos + len).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

// Um caminho é seguro se for relativo, usar "/" e não contenha "." ou "..".
// Tudo o resto (absolutos, traversal, barras invertidas) é rejeitado: um tarball
// remoto não tem nenhuma razão legítima para escrever fora do destino.
export function isUnsafeEntryName(name) {
  if (typeof name !== "string" || name === "") return true;
  if (name.includes("\\")) return true;
  if (name.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(name)) return true; // "C:/..." escaparia da raiz em Windows
  if (name.includes("\0")) return true;
  return name.split("/").some((segment) => segment === ".." || segment === ".");
}

// Lista as entradas de um tar descompactado. Só devolve ficheiros regulares e
// diretórios — symlinks, hardlinks e devices são descartados com um aviso em vez
// de seguirem para a extracção.
export function parseTar(
  buffer,
  { maxEntries = DEFAULT_MAX_ENTRIES, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES, maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = {},
) {
  const entries = [];
  const warnings = [];
  let totalBytes = 0;
  let offset = 0;
  let pendingPax = null;
  let pendingLongName = null;

  while (offset + BLOCK_SIZE <= buffer.length) {
    if (isZeroBlock(buffer, offset)) break;

    const headerStart = offset;
    const name = readString(buffer, headerStart, 100);
    const size = readNumeric(buffer, headerStart + 124, 12);
    const typeflag = String.fromCharCode(buffer[headerStart + 156]) || "0";
    const prefix = readString(buffer, headerStart + 345, 155);
    const dataStart = headerStart + BLOCK_SIZE;
    const dataEnd = dataStart + size;

    if (size < 0 || dataEnd > buffer.length) {
      throw new TarError(`entrada de tar truncada: "${name}" (size ${size})`);
    }
    if (size > maxEntryBytes) {
      throw new TarError(`entrada de tar demasiado grande: "${name}" (${size} bytes)`);
    }

    const data = buffer.subarray(dataStart, dataEnd);
    const padded = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    // Cabeçalhos estendidos: alteram a entrada seguinte em vez de a descreverem.
    if (typeflag === "x" || typeflag === "X") {
      pendingPax = { ...pendingPax, ...parsePax(data) };
      offset = dataStart + padded;
      continue;
    }
    if (typeflag === "L") {
      pendingLongName = readString(data, 0, data.length).replace(/\0.*$/, "");
      offset = dataStart + padded;
      continue;
    }
    if (typeflag === "g") {
      offset = dataStart + padded;
      continue;
    }

    let finalName = name;
    if (prefix !== "" && !name.startsWith("./")) finalName = `${prefix}/${name}`;
    if (pendingLongName != null) {
      finalName = pendingLongName;
      pendingLongName = null;
    }
    let finalSize = size;
    if (pendingPax != null) {
      if (pendingPax.path) finalName = pendingPax.path;
      // O `size` do pax é decimal (ao contrário dos campos do cabeçalho, que são
      // octais) — daí o parseInt directo.
      if (pendingPax.size && /^[0-9]+$/.test(pendingPax.size)) finalSize = Number(pendingPax.size);
      pendingPax = null;
    }

    offset = dataStart + padded;
    if (typeflag === "5") continue; // diretório: a criação é implícita
    if (typeflag !== "0") {
      warnings.push(`ignorado (tipo '${typeflag}'): ${finalName}`);
      continue;
    }

    entries.push({
      name: finalName,
      size: finalSize,
      mode: readNumeric(buffer, headerStart + 100, 8),
      data,
    });
    totalBytes += size;
    if (entries.length > maxEntries) throw new TarError(`tarball com mais de ${maxEntries} entradas`);
    if (totalBytes > maxTotalBytes) throw new TarError("tarball excede o limite de tamanho descomprimido");
  }

  return { entries, warnings, totalBytes };
}

// O GitHub embrulha tudo num único diretório de raiz ("peal-skills-main/…").
// Derivamo-lo das próprias entradas em vez de tentar adivinhar a ref.
export function detectRootDir(names) {
  const first = names.find((n) => n !== "");
  if (!first) return "";
  const root = first.split("/")[0];
  return first.includes("/") ? root : "";
}

export function findEntry(entries, name) {
  return entries.find((e) => e.name === name) ?? null;
}

// Extrai os ficheiros regulares de `<root>/<subpath>/**` para `destDir`.
// Devolve os hashes por ficheiro, que é o que o manifesto precisa. O `dry-run`
// vive um nível acima, no `ensureSkills`, para que a decisão de não escrever
// nunca chegue ao meio de uma instalação.
export async function extractSubtree(buffer, { subpath, destDir, ...limits } = {}) {
  const { entries, warnings } = parseTar(buffer, limits);
  const root = detectRootDir(entries.map((e) => e.name));
  const prefix = subpath ? `${root}/${subpath.replace(/\/+$/, "")}/` : `${root}/`;

  const files = [];
  const skipped = [];

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) {
      skipped.push(entry.name);
      continue;
    }
    const relative = entry.name.slice(prefix.length);
    if (relative === "") continue;
    if (isUnsafeEntryName(relative)) {
      // Já não filtrámos antes porque o nome do tarball é controlado por outro
      // host; aqui o caminho é relativo e vai ser escrito em disco.
      warnings.push(`ignorado (caminho inseguro): ${entry.name}`);
      continue;
    }
    const destination = join(destDir, ...relative.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.data);
    files.push({ path: relative, sha256: createHash("sha256").update(entry.data).digest("hex"), bytes: entry.size });
  }

  if (files.length === 0) {
    throw new TarError(`o tarball não contém a subpasta "${subpath}"`);
  }

  return { files: files.sort((a, b) => (a.path < b.path ? -1 : 1)), warnings, skipped: skipped.length, root };
}
