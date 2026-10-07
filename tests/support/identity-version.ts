import type { DatabaseSync } from "node:sqlite";

export const TEST_IDENTITY_VERSION = "1.2.3";

export function seedIdentityVersions(
  sqlite: DatabaseSync,
  version = TEST_IDENTITY_VERSION
): void {
  sqlite.prepare(
    `INSERT INTO upstream_identity_version (identity, version)
     VALUES ('codex_cli', ?), ('grok_build', ?)`
  ).run(version, version);
}
