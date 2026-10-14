import { gzipSync } from "node:zlib";

// Construção de tarballs mínimos em memória para os testes. Existe para não
// trazer uma dependência de runtime só para testes (ver src/tar.js): o formato
// é pequeno o suficiente para o escrevermos à mão e assim conseguimos fabricar
// também os casos que um git limpo nunca produziria (symlinks, path traversal,
// cabeçalhos pax).

function octal(value, length) {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function header({ name, size, typeflag, prefix }) {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(octal(0o644, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.write("        ", 148, "ascii"); // placeholder do checksum
  block.write(typeflag, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  if (prefix) block.write(prefix.slice(0, 155), 345, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return block;
}

function body(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  const padding = (512 - (buffer.length % 512)) % 512;
  return Buffer.concat([buffer, Buffer.alloc(padding)]);
}

// `entries`: [{ name, data?, typeflag? }]. Devolve o tar (sem gzip).
// Symlinks e hardlinks entram sempre com size 0, como num tar real — são o que
// os testes usam para confirmar que o extractor os descarta.
export function makeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const typeflag = entry.typeflag ?? "0";
    const link = typeflag === "1" || typeflag === "2";
    const data = link ? "" : (entry.data ?? "");
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
    blocks.push(header({ name: entry.name, size, typeflag, prefix: entry.prefix }));
    if (!link) blocks.push(body(data));
  }
  blocks.push(Buffer.alloc(1024)); // fim do arquivo
  return Buffer.concat(blocks);
}

// Registo pax: "<len> <chave>=<valor>\n", onde <len> conta o próprio registo.
// O comprimento é auto-referencial, por isso se resolve por tentativa.
export function paxRecord(key, value) {
  const minimum = key.length + value.length + 2;
  for (let len = minimum; len < minimum + 40; len += 1) {
    const record = `${len} ${key}=${value}\n`;
    if (Buffer.byteLength(record) === len) return record;
  }
  throw new Error("não foi possível construir o registo pax");
}

export function makeTarball(entries) {
  return gzipSync(makeTar(entries));
}

// Um tarball com a forma do GitHub: tudo debaixo de um único diretório de raiz.
export function makeRepoTarball(root, entries, extra = []) {
  return makeTarball([
    ...extra.map((e) => ({ ...e, name: `${root}/${e.name}` })),
    ...entries.map((e) => ({ ...e, name: `${root}/${e.name}` })),
  ]);
}

// fetch de mentira: escolhe a resposta pelo que o URL contém.
export function fakeFetch(routes = {}, { onCall } = {}) {
  return async (url) => {
    onCall?.(String(url));
    for (const [needle, response] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        const status = response.status ?? 200;
        const payload = response.body ?? "";
        const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
        return new Response(bytes, {
          status,
          statusText: response.statusText ?? "",
          headers: { "content-length": String(bytes.length) },
        });
      }
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
}
