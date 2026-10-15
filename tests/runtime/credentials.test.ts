import { expect,it } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { credentialFixture } from "./credential-fixture";

// Accept exact immutable versions; reject late writes and latest-key substitution.
// Storage layout and encryption bytes may change without changing this contract.
it("fences cleaned versions across restart and keeps installations separate",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"runtime-credential-"));
  let fixture=await credentialFixture(directory);
  try {
    let first=fixture.namespace.getByName("first");
    const second=fixture.namespace.getByName("second");
    await first.put("first","version-a",2,"synthetic-a");
    await second.put("second","version-a",2,"synthetic-other");
    await first.clean("first",2,"version-a");
    await first.put("first","version-b",3,"synthetic-b");
    expect(await first.read("first","version-a",2)==="synthetic-a").toBe(true);
    await first.clean("first",3,"version-b");
    expect(await first.read("first","version-a",2)).toBeNull();
    expect(await second.read("second","version-a",2)==="synthetic-other").toBe(true);
    await first.clean("first",4,null);
    await fixture.dispose(); fixture=await credentialFixture(directory);
    first=fixture.namespace.getByName("first");
    await expect(first.put("first","late",3,"synthetic-late")).rejects.toThrow();
    expect(await first.read("first","version-b",3)).toBeNull();
    await first.put("first","future",5,"synthetic-new");
    await first.clean("first",3,null);
    expect(await first.read("first","future",5)==="synthetic-new").toBe(true);
  } finally {await fixture.dispose();await rm(directory,{recursive:true,force:true});}
},20000);
