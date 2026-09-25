import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommandArgs } from "../src/args.ts";
import { AutoPageClient } from "../src/page-transport.ts";
import { PageCapabilityCache, pageTransportReport } from "../src/page-cache.ts";
import { dispatchPageCommand } from "../src/page-dispatch.ts";
import { wikiPages, formatPages } from "../src/commands/page-data.ts";
import { outline, readFragment } from "../src/page-document.ts";
import { openLive } from "../src/page-live.ts";
import { closeServers, server } from "./page-wire.ts";
import heading from "./fixtures/pages/heading.json";
import replacement from "./fixtures/pages/replacement.json";
import { ALL_COMMANDS } from "../src/registry.ts";

const originalFetch = globalThis.fetch, originalWrite = process.stdout.write;
const keys = ["NO_PROXY", "PLANE_PAGE_CACHE", "PLANE_LOGIN", "PLANE_PASSWORD"];
const rootId = "10000000-0000-4000-8000-000000000001", childId = "10000000-0000-4000-8000-000000000002";
let previous: Record<string, string | undefined>, directory: string, printed: string, config: any;
let calls: {path: string; method: string; body: any; headers: Headers}[];
let rows: any[], runtime: any, runtimeStatus: number, listStatus: number, detailStatus: number, deleteStatus: number;
beforeEach(async () => {
  previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  directory = await mkdtemp(join(tmpdir(), "ipl-wiki-"));
  process.env.NO_PROXY = "*"; process.env.PLANE_PAGE_CACHE = directory;
  delete process.env.PLANE_LOGIN; delete process.env.PLANE_PASSWORD;
  printed = ""; calls = []; runtimeStatus = listStatus = detailStatus = deleteStatus = 200;
  config = {url: {value:"http://127.0.0.1:9999",origin:"flag"}, token:{value:"wiki-key-secret",origin:"flag"}, workspace:{value:"workspace",origin:"flag"}, configPath:"/dev/null"};
  rows = [{id:childId,name:"Child",parent:rootId,sort_order:1,created_at:"2026-01-01",archived_at:"2026-01-02"},{id:rootId,name:"Root",parent:null,sort_order:20,created_at:"2026-01-01"}];
  runtime = {release:"wiki-test", extensions:[{id:"api-key-pages",enabled:true},{id:"workspace-wiki",enabled:true}]};
  process.stdout.write = ((chunk: string) => {printed += chunk; return true;}) as typeof originalWrite;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname, method=init?.method ?? "GET", body=init?.body ? JSON.parse(String(init.body)):undefined;
    calls.push({path,method,body,headers:new Headers(init?.headers)});
    if (path === "/api/extensions/configuration/") return runtimeStatus===200 ? Response.json(runtime) : new Response(null,{status:runtimeStatus});
    if (path === "/api/extensions/node-readers/") return new Response(null,{status:404});
    if (path === "/live/convert-document") return Response.json(body.description_html===heading.html ? heading.response : replacement.response);
    if (path === "/api/v1/workspaces/workspace/pages/") {
      if (method === "POST") return Response.json({id:rootId,...body});
      return listStatus===200 ? Response.json(rows) : new Response(null,{status:listStatus});
    }
    const match = /^\/api\/v1\/workspaces\/workspace\/pages\/([^/]+)\/$/.exec(path);
    if (match) {
      if (method === "DELETE") return deleteStatus===200 ? new Response(null,{status:204}) : Response.json({detail:"Archive the page before deleting it."},{status:deleteStatus});
      if (detailStatus!==200) return new Response(null,{status:detailStatus});
      return Response.json({...rows.find(r=>r.id===match[1]),description_html:heading.html});
    }
    throw new Error(`Unexpected route: ${method} ${path}`);
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch=originalFetch;process.stdout.write=originalWrite;closeServers();
  for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await rm(directory,{recursive:true,force:true});
});
const client = () => new AutoPageClient(config,{placement:"wiki"});
async function run(...words:string[]) {
  printed="";const args=parseCommandArgs(["wiki",...words]);
  await dispatchPageCommand(args.path.join(" "),client(),args,true);
  return JSON.parse(printed);
}

test("wiki list preserves every parent and archive in deterministic preorder", async () => {
  const result=await run("list");
  expect(result.map((r:any)=>r.id)).toEqual([rootId,childId]);
  expect(result.map((r:any)=>r.parent)).toEqual([null,rootId]);
  expect(result[1].archived_at).toBe("2026-01-02");
  expect(formatPages(result,true)).toContain(rootId);
  expect(formatPages(result,true)).toContain("—");
  expect(calls.map(c=>c.path)).toEqual(["/api/extensions/configuration/","/api/v1/workspaces/workspace/pages/"]);
});
test("wiki ordering breaks rank ties and retains missing parents and cycles once", () => {
  const input=[{id:"z",name:"Z",parent:"missing",sort_order:1,created_at:"b"},{id:"a",name:"A",parent:null,sort_order:1,created_at:"a"},{id:"b",name:"B",parent:"c",sort_order:2},{id:"c",name:"C",parent:"b",sort_order:2}];
  expect(wikiPages(input).map(r=>r.id)).toEqual(["a","z","b","c"]);
  expect(wikiPages(input.reverse()).map(r=>r.id)).toEqual(["a","z","b","c"]);
  expect(wikiPages(input).find(r=>r.id==="z")?.parent).toBe("missing");
});
test("wiki create resolves nested parent before a single POST", async () => {
  await run("create","--name","New","--parent","Chi");
  const posts=calls.filter(c=>c.method==="POST");expect(posts).toHaveLength(1);
  expect(posts[0].body).toEqual({name:"New",access:0,parent:childId});
  expect(posts[0].path).toBe("/api/v1/workspaces/workspace/pages/");
});
test("wiki duplicate names report candidates before writing", async () => {
  rows[1].name="Child";
  const error=await run("create","--name","New","--parent","Child").catch(e=>e);
  expect(error.message).toContain(rootId);expect(error.message).toContain(childId);
  expect(calls.some(c=>c.method!=="GET")).toBe(false);
});
test("wiki deletion asks the server without automatic archiving", async () => {
  deleteStatus=400;
  await expect(run("rm",rootId,"--yes")).rejects.toThrow("Archive the page before deleting it");
  expect(calls.filter(c=>c.method!=="GET").map(c=>[c.method,c.path])).toEqual([["DELETE",`/api/v1/workspaces/workspace/pages/${rootId}/`]]);
  deleteStatus=200;expect(await run("rm",childId,"--yes")).toEqual({id:childId,deleted:true});
});
for(const status of [401,403,404,429,500]) test(`wiki HTTP ${status} never selects session or projects`,async()=>{
  listStatus=status;
  const e=await run("list").catch(e=>e);expect(e.status).toBe(status);
  expect(calls.every(c=>!c.path.includes("projects")&&!c.path.startsWith("/auth/"))).toBe(true);
});
test("wiki unsupported server refuses before page operations", async () => {
  for(const mode of ["absent","disabled","no-key-pages","no-release"]){
    calls=[];runtimeStatus=mode==="absent"?404:200;
    runtime={release:mode==="no-release"?null:"r",extensions:[{id:"workspace-wiki",enabled:mode!=="disabled"},{id:"api-key-pages",enabled:mode!=="no-key-pages"}]};
    await expect(run("create","--name","New")).rejects.toThrow("not supported");
    expect(calls.map(c=>c.path)).toEqual(["/api/extensions/configuration/"]);
  }
});
test("wiki cached project session cannot change identity and runtime disable is rechecked", async () => {
  const cache=new PageCapabilityCache(config.url.value);
  await cache.write("session","missing-route",false,true);
  await run("list");expect((await cache.read())?.mode).toBe("session");
  expect(calls.every(c=>!c.headers.has("Cookie"))).toBe(true);
  runtime.extensions[1].enabled=false;
  await expect(run("list")).rejects.toThrow("not supported");
});
test("wiki live scope has workspace kind and no project identifier", async () => {
  const wire=await server();config.url.value=wire.url;
  const live=await openLive(client(),{kind:"wiki"},rootId,{writable:false});
  live.destroy();
  const auth=wire.authentications[0];const url=new URL(auth.url,wire.url);
  expect(url.searchParams.get("documentType")).toBe("workspace_page");
  expect(url.searchParams.has("projectId")).toBe(false);
  expect(JSON.parse(auth.token)).toEqual({apiKey:"wiki-key-secret",readOnly:true});
});
test("wiki shared commands edit blocks without any project HTTP route", async () => {
  const wire=await server();config.url.value=wire.url;
  const created=await run("create","--name","Root","--text",heading.markdown);
  expect(created.delivery).toBe("acknowledged");
  await run("stamp",rootId);
  const initial=await run("outline",rootId);expect(initial).toHaveLength(2);
  const block=await run("read",rootId,"--block",initial[0].anchor);
  await run("set",rootId,"--block",initial[0].anchor,"--if-match",block.fingerprint,"--text",replacement.markdown);
  await expect(run("set",rootId,"--block",initial[0].anchor,"--if-match",block.fingerprint,"--text",heading.markdown)).rejects.toThrow("content changed");
  await run("set",rootId,"--block",initial[0].anchor,"--force","--text",heading.markdown);
  await run("insert",rootId,"--at-end","--text",replacement.markdown);
  const inserted=outline(wire.fragment).at(-1)!;
  await run("rm",rootId,"--block",inserted.anchor!,"--yes");
  expect(readFragment(wire.fragment).markdown).toContain("Heading");
  expect((await run("show","Root")).markdown).toContain("Heading");
  await run("list");
  expect(calls.every(c=>!c.path.includes("/projects/"))).toBe(true);
  expect(calls.every(c=>c.headers.get("X-Api-Key")==="wiki-key-secret")).toBe(true);
});
test("wiki flags mirror page commands with parent only on creation", () => {
  for(const c of ALL_COMMANDS.filter(c=>c.name.startsWith("page "))){
    const w=ALL_COMMANDS.find(w=>w.name===c.name.replace("page ","wiki "))!;
    expect(w.options?.filter(o=>o.flag!=="--parent")).toEqual(c.options);
    expect(w.maxPositionals).toBe(c.maxPositionals!-1);
    expect(w.examples?.length).toBeGreaterThan(0);expect(w.next?.length).toBeGreaterThan(0);
  }
});
test("wiki invalid calls fail before credentials or requests", async () => {
  for (const words of [
    ["rm", rootId, "--yes=false"], ["set", rootId, "--block=", "--text", "bad"],
    ["create", "--name", "New", "--parent="], ["read", rootId],
    ["insert", rootId, "--after", "a", "--at-end", "--text", "bad"],
    ["set", rootId, "--force", "--text", "bad"],
  ]) await expect(run(...words)).rejects.toThrow();
  expect(calls).toEqual([]);
});
test("wiki missing key is a usage error without resolving session credentials", async () => {
  config.token.value="";process.env.PLANE_LOGIN="unused";process.env.PLANE_PASSWORD="unused";
  await expect(run("list")).rejects.toThrow("Wiki commands require PLANE_API_KEY");
  expect(calls).toEqual([]);
});
test("wiki capability authorization and invalid inventory remain failures", async () => {
  for(const status of [401,403,500]){
    runtimeStatus=status;const e=await run("list").catch(e=>e);expect(e.status).toBe(status);
  }
  runtimeStatus=200;runtime={extensions:"invalid"};
  await expect(run("list")).rejects.toThrow("Invalid extension configuration");
  expect(calls.every(c=>c.path==="/api/extensions/configuration/")).toBe(true);
});
test("wiki detail 404 and deletion 403 do not select another scope", async () => {
  detailStatus=404;const missing=await run("show",rootId).catch(e=>e);expect(missing.status).toBe(404);
  detailStatus=200;deleteStatus=403;
  await expect(run("rm",childId,"--yes")).rejects.toThrow("403");
  expect(calls.every(c=>!c.path.includes("projects")&&!c.path.startsWith("/auth/"))).toBe(true);
});
test("wiki reader absence rejects custom nodes before page creation", async () => {
  await expect(run("create","--name","Review","--text",'```knowledge-review\n{"date":"2026-09-25","source":"Manual check"}\n```')).rejects.toThrow("has not confirmed a reader");
  expect(calls.some(c=>c.method!=="GET")).toBe(false);
});
test("wiki and project cache share refresh but never transport identity", async () => {
  const wiki=new PageCapabilityCache(config.url.value,undefined,undefined,"wiki");
  await run("list");expect((await wiki.read())?.reason).toBe("wiki-runtime");
  await pageTransportReport(config.url.value,true);expect(await wiki.read()).toBeUndefined();
});
