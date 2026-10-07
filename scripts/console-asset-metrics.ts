import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Fixed algorithms for build attribution, not claims about HTTP compression. */
export function consoleAssetBytes(value: string | Buffer) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return {
    utf8: bytes.byteLength,
    gzip9: gzipSync(bytes, { level: 9 }).byteLength,
    brotli11: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength
  };
}
