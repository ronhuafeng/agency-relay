import { expect, it } from "vitest";
import { assertDeployment, assertVersion, assertMigrations } from "../../scripts/release-control";

it("requires every current migration without treating retained historical ledger names as pending work", () => {
  const expected = ["0001_initial.sql", "0002_current.sql"];
  expect(() => assertMigrations(expected, [...expected, "0001_retired.sql"])).not.toThrow();
  expect(() => assertMigrations(expected, ["0001_initial.sql"])).toThrow();
  expect(() => assertMigrations(expected, [...expected, "0003_future.sql"])).toThrow();
});

it("requires the exact source, runtime, secrets, database and stable namespace before cutover", () => {
  const config = { name: "fixture", compatibility_date: "2026-06-24", compatibility_flags: ["global_fetch_strictly_public"], vars: { MODE: "production" }, secrets: { required: ["SECRET"] }, d1_databases: [{binding:"DB",database_id:"database"}], durable_objects: {bindings:[{name:"AUTH",class_name:"Authority"}]} };
  const version = { id: "new", annotations: {"workers/message":"release sha"}, resources: {script_runtime:{compatibility_date:config.compatibility_date,compatibility_flags:config.compatibility_flags}, bindings:[
    {name:"SECRET",type:"secret_text"}, {name:"MODE",type:"plain_text",text:"production"},
    {name:"DB",type:"d1",id:"database"}, {name:"AUTH",type:"durable_object_namespace",class_name:"Authority",namespace_id:"namespace"},
  ]}};
  expect(() => assertVersion(version, config, "sha", version)).not.toThrow();
  expect(() => assertVersion(version, config, "wrong", version)).toThrow("annotation");
  for (const name of ["SECRET","MODE","DB","AUTH"]) {
    const broken = structuredClone(version);
    broken.resources.bindings = broken.resources.bindings.filter(binding => binding.name !== name);
    expect(() => assertVersion(broken, config, "sha", version)).toThrow();
  }
  const moved = structuredClone(version);
  moved.resources.bindings[3].namespace_id = "different";
  expect(() => assertVersion(moved, config, "sha", version)).toThrow("namespace changed");
  const flags = structuredClone(version);
  flags.resources.script_runtime.compatibility_flags = [];
  expect(() => assertVersion(flags, config, "sha", version)).toThrow("runtime mismatch");
});
it("requires authoritative 100 percent deployment rather than upload success", () => {
  expect(() => assertDeployment({id:"deployment",versions:[{version_id:"expected",percentage:100}]}, "expected")).not.toThrow();
  expect(() => assertDeployment({id:"deployment",versions:[{version_id:"other",percentage:100}]}, "expected")).toThrow();
  expect(() => assertDeployment({id:"deployment",versions:[{version_id:"expected",percentage:50},{version_id:"old",percentage:50}]}, "expected")).toThrow();
});
