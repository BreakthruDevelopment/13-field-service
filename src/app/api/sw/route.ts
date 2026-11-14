import { buildId } from "@/lib/build-id";

export const dynamic = "force-dynamic";

/**
 * The technician shell. Cache names include the build id so an activate drops the previous build.
 * Scope is the whole origin so `/_next/static` can be cached with the shell. The handler never
 * caches `/api/*` or any HTML except `/tech`, so dispatcher and admin pages are not served offline.
 */
function script(id: string): string {
  return `const BUILD=${JSON.stringify(id)};
const SHELL="fsd-shell-"+BUILD;
const STATIC="fsd-static-"+BUILD;

self.addEventListener("install",function(){self.skipWaiting();});

self.addEventListener("activate",function(event){
  event.waitUntil((async function(){
    var keys=await caches.keys();
    await Promise.all(keys.filter(function(key){return key.indexOf("fsd-")===0 && key!==SHELL && key!==STATIC;}).map(function(key){return caches.delete(key);}));
    await self.clients.claim();
  })());
});

self.addEventListener("message",function(event){
  if(!event.data || event.data.type!=="CLEAR") return;
  event.waitUntil((async function(){
    var keys=await caches.keys();
    await Promise.all(keys.filter(function(key){return key.indexOf("fsd-")===0;}).map(function(key){return caches.delete(key);}));
  })());
});

self.addEventListener("fetch",function(event){
  var request=event.request;
  if(request.method!=="GET") return;
  var url=new URL(request.url);
  if(url.origin!==self.location.origin) return;
  if(url.pathname.indexOf("/api/")===0) return;
  if(url.pathname.indexOf("/_next/static/")===0 || url.pathname==="/manifest.webmanifest" || url.pathname==="/icon" || url.pathname.indexOf("/icon")==0 || url.pathname.indexOf("/branding/")===0){
    event.respondWith(cacheFirst(STATIC, request));
    return;
  }
  var tech=request.mode==="navigate" && (url.pathname==="/tech" || url.pathname==="/tech/");
  if(!tech) return;
  event.respondWith(shell(request));
});

async function cacheFirst(name, request){
  var cache=await caches.open(name);
  var hit=await cache.match(request);
  if(hit) return hit;
  var response=await fetch(request);
  if(response && response.status===200) await cache.put(request, response.clone());
  return response;
}

async function shell(request){
  var cache=await caches.open(SHELL);
  try {
    var response=await fetch(request);
    var finalUrl=new URL(response.url);
    var ok=response.status===200 && !response.redirected && (finalUrl.pathname==="/tech" || finalUrl.pathname==="/tech/");
    if(ok) await cache.put(request, response.clone());
    if(response.redirected || response.status===301 || response.status===302 || response.status===307 || response.status===308){
      await caches.delete(SHELL);
      await caches.delete(STATIC);
    }
    return response;
  } catch (err) {
    var cached=await cache.match(request) || await cache.match("/tech");
    if(cached) return cached;
    return new Response("Offline", {status:503, headers:{"Content-Type":"text/plain; charset=utf-8"}});
  }
}
`;
}

export function GET() {
  return new Response(script(buildId()), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'",
    },
  });
}
