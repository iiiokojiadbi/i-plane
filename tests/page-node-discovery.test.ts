import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Config} from "../src/config.ts";
import {AutoPageClient} from "../src/page-transport.ts";
import {PageCapabilityCache,PAGE_CAPABILITY_TTL,pageTransportReport} from "../src/page-cache.ts";
import {prepareMarkdown} from "../src/page-document.ts";
import {guardSecret} from "../src/output.ts";
import review from "./fixtures/pages/knowledge-review.json";
import heading from "./fixtures/pages/heading.json";

const originalFetch=globalThis.fetch;
const runtimePath="/api/extensions/configuration/", readerPath="/api/extensions/node-readers/";
let directory:string,config:Config,calls:string[],runtime:Record<string,unknown>,inventory:unknown;
let runtimeStatus:number,readerStatus:number;
let oldProxy:string|undefined;
const cache=()=>new PageCapabilityCache(config.url.value,directory);
const client=(refresh=false)=>new AutoPageClient(config,{cache:cache(),refresh});
beforeEach(async()=>{
 directory=await mkdtemp(join(tmpdir(),"ipl-node-discovery-"));
 config={url:{value:"https://plane.test",origin:"flag"},token:{value:"reader-test-key",origin:"flag"},workspace:{value:"test",origin:"flag"},configPath:"/dev/null"};
 calls=[];runtimeStatus=200;readerStatus=200;
 runtime={release:"reader-release",coreVersion:"0.2.1",protocolVersion:1,readerFingerprint:"a".repeat(64),extensions:[{id:"api-key-pages",enabled:true}]};
 inventory={schemaVersion:1,coreVersion:"0.2.1",protocolVersion:1,release:"reader-release",fingerprint:"a".repeat(64),readers:[{id:"knowledge-review",formatVersion:1,nodeNames:["knowledgeReview"]}]};
 oldProxy=process.env.NO_PROXY;process.env.NO_PROXY="*";
 globalThis.fetch=(async(input,init)=>{
  const path=new URL(String(input)).pathname;calls.push(path);
  expect(new Headers(init?.headers).has("Cookie")).toBe(false);
  if(path===runtimePath)return runtimeStatus===200?Response.json(runtime):new Response(null,{status:runtimeStatus});
  if(path===readerPath)return readerStatus===200?Response.json(inventory):new Response(null,{status:readerStatus});
  if(path.startsWith("/live/convert-document"))return Response.json(review.response);
  return Response.json([]);
 }) as typeof fetch;
});
afterEach(async()=>{
 globalThis.fetch=originalFetch;guardSecret("");
 if(oldProxy===undefined)delete process.env.NO_PROXY;else process.env.NO_PROXY=oldProxy;
 await rm(directory,{recursive:true,force:true});
});
const count=(path:string)=>calls.filter(value=>value===path).length;

test("node readers share the transport cache, refresh flag and private credential-free file",async()=>{
 const first=client();await first.preparePages("project");expect(await first.nodeReaders()).toEqual(["knowledgeReview"]);
 const prepared=await prepareMarkdown(first,review.markdown);prepared.doc.destroy();
 expect(count(readerPath)).toBe(1);
 const second=client();await second.preparePages("project");expect(await second.nodeReaders()).toEqual(["knowledgeReview"]);
 expect(count(readerPath)).toBe(1);expect(count(runtimePath)).toBe(3);
 const file=await readFile(cache().path,"utf8");expect(file).not.toContain(config.token.value);
 expect(JSON.parse(file).nodeReaders.nodes).toEqual(["knowledgeReview"]);
 expect((await stat(cache().path)).mode&0o777).toBe(0o600);
 const refreshed=client(true);await refreshed.preparePages("project");expect(await refreshed.nodeReaders()).toEqual(["knowledgeReview"]);
 expect(count(readerPath)).toBe(2);
});

test("vanilla and older cores refuse, and installing readers invalidates a cached refusal",async()=>{
 runtimeStatus=404;const vanilla=client();await vanilla.preparePages("project");expect(await vanilla.nodeReaders()).toEqual([]);
 expect(count(readerPath)).toBe(0);
 runtimeStatus=200;readerStatus=404;runtime={release:"old",extensions:[]};
 const old=client();await old.preparePages("project");expect(await old.nodeReaders()).toEqual([]);expect(count(readerPath)).toBe(1);
 runtime={release:"reader-release",coreVersion:"0.2.1",protocolVersion:1,readerFingerprint:"a".repeat(64),extensions:[]};readerStatus=200;
 const upgraded=client();await upgraded.preparePages("project");expect(await upgraded.nodeReaders()).toEqual(["knowledgeReview"]);expect(count(readerPath)).toBe(2);
});

test("a rollback never reuses a previous positive reader claim",async()=>{
 const first=client();await first.preparePages("project");await first.nodeReaders();
 runtime={release:"previous",coreVersion:"0.2.0",protocolVersion:1,extensions:[]};readerStatus=404;
 const rolledBack=client();await rolledBack.preparePages("project");expect(await rolledBack.nodeReaders()).toEqual([]);
 expect(count(readerPath)).toBe(2);
});

test("reader expiry and explicit refresh reprobe within the transport cache lifetime",async()=>{
 const first=client();await first.preparePages("project");await first.nodeReaders();
 const value=JSON.parse(await readFile(cache().path,"utf8"));value.nodeReaders.checkedAt-=PAGE_CAPABILITY_TTL;value.nodeReaders.expiresAt-=PAGE_CAPABILITY_TTL;
 await writeFile(cache().path,JSON.stringify(value));
 const expired=client();await expired.preparePages("project");await expired.nodeReaders();expect(count(readerPath)).toBe(2);
 // Use the same cache directory as offline diagnostics, rather than a second cache.
 const old=process.env.PLANE_PAGE_CACHE;process.env.PLANE_PAGE_CACHE=directory;
 try{await pageTransportReport(config.url.value,true);expect(await cache().read()).toBeUndefined();}
 finally{if(old===undefined)delete process.env.PLANE_PAGE_CACHE;else process.env.PLANE_PAGE_CACHE=old;}
});

for(const status of [401,403,429,500,503]) for(const endpoint of ["runtime","readers"]) test(`${endpoint} ${status} is not cached as absent preservation`,async()=>{
 const candidate=client();await candidate.preparePages("project");
 if(endpoint==="runtime")runtimeStatus=status;else readerStatus=status;
 const error=await candidate.nodeReaders().catch(error=>error);expect(error.status).toBe(status);
 expect((await cache().read())?.nodeReaders).toBeUndefined();
});

test("malformed, mixed-release and duplicate reader inventories fail without caching absence",async()=>{
 const good=inventory as Record<string,unknown>;
 for(const broken of [null,{}, {...good,schemaVersion:2},{...good,release:"other"},{...good,fingerprint:"b".repeat(64)},
  {...good,readers:[{id:"review",formatVersion:1,nodeNames:["knowledgeReview","knowledgeReview"]}]},
  {...good,readers:[{id:"review",formatVersion:0,nodeNames:["knowledgeReview"]}]}]){
  inventory=broken;const candidate=client();await candidate.preparePages("project");
  await expect(candidate.nodeReaders()).rejects.toThrow(/Invalid/);expect((await cache().read())?.nodeReaders).toBeUndefined();
 }
});

test("future node formats do not silently authorize the current writer",async()=>{
 inventory={...(inventory as object),readers:[{id:"knowledge-review",formatVersion:2,nodeNames:["knowledgeReview"]}]};
 await expect(prepareMarkdown(client(),review.markdown)).rejects.toThrow("has not confirmed a reader");
 expect(calls.some(path=>path.startsWith("/live/"))).toBe(false);
});

test("ordinary Markdown does not probe node capabilities",async()=>{
 const fetch=globalThis.fetch;
 globalThis.fetch=(async(input,init)=>String(input).includes("/live/")?Response.json(heading.response):fetch(input,init)) as typeof fetch;
 const prepared=await prepareMarkdown(client(),heading.markdown);prepared.doc.destroy();
 expect(count(runtimePath)).toBe(0);expect(count(readerPath)).toBe(0);
});

test("a misreported converter cannot lose confirmed review nodes or attributes",async()=>{
 for(const response of [heading.response,review.response]) {
  const fetch=globalThis.fetch;
  globalThis.fetch=(async(input,init)=>String(input).includes("/live/")?Response.json(response):fetch(input,init)) as typeof fetch;
  const markdown=response===review.response?review.markdown+"\n\n"+review.markdown:review.markdown;
  await expect(prepareMarkdown(client(),markdown)).rejects.toThrow("did not preserve the confirmed knowledgeReview");
  globalThis.fetch=fetch;
 }
});
