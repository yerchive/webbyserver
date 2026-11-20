// /blox/: Roblox's browser client. The host page (webblox/) and its relay
// worker, the epoxy Wisp client they share with the browser page, and the
// engine pulled by scripts/fetch-webblox.mjs (vendor/webblox/engine/).
//
// Every response is cross-origin isolated: the engine runs on pthreads over a
// shared WebAssembly.Memory, which needs SharedArrayBuffer.
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";

export const BLOX_PREFIX = "/blox/";

const HOST_FILES: Record<string, true> = { "index.html": true, "host.js": true, "host.css": true, "sw.js": true };
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};
// Engine content paths as the metadata list writes them; anything else is
// not something the engine asks for.
const ENGINE_PATH = /^[A-Za-z0-9_@ .()+-]+(?:\/[A-Za-z0-9_@ .()+-]+)*$/;

export type BloxPaths = {
  /** webblox/: index.html, host.js, host.css, sw.js. */
  host: string;
  /** vendor/webblox/engine/. */
  engine: string;
  /** The epoxy Wisp client bundle (@mercuryworkshop/epoxy-transport's dist/index.mjs). */
  epoxy: string;
};

function isolated(headers: Record<string, string>): Headers {
  return new Headers({
    ...headers,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: isolated({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }) });
}

function inside(root: string, relative: string): string | null {
  const path = resolve(root, relative);
  return path.startsWith(`${root}${sep}`) ? path : null;
}

export function createBloxHandler(paths: BloxPaths, fetchImpl: typeof fetch = fetch) {
  const host = resolve(paths.host);
  const engine = resolve(paths.engine);
  const epoxy = resolve(paths.epoxy);

  // Revalidated on every load (no-cache + last-modified): the engine keeps the
  // same paths across versions, so a cached WebClient.js must never outlive
  // the WebClient.wasm it was built with.
  async function serveFile(req: Request, path: string): Promise<Response | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const ext = extname(path).toLowerCase();
    const headers: Record<string, string> = {
      "content-type": MIME_TYPES[ext] || file.type || "application/octet-stream",
      "cache-control": "no-cache",
      "last-modified": new Date(file.lastModified).toUTCString(),
    };
    const since = Date.parse(req.headers.get("if-modified-since") ?? "");
    if (Number.isFinite(since) && Math.floor(file.lastModified / 1000) <= Math.floor(since / 1000)) {
      return new Response(null, { status: 304, headers: isolated(headers) });
    }
    let body: Blob = file;
    // fetch-webblox.mjs leaves a gzip copy of the 100 MB engine binary.
    const gzip = Bun.file(`${path}.gz`);
    if (/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "") && (await gzip.exists())) {
      body = gzip;
      headers["content-encoding"] = "gzip";
      headers.vary = "Accept-Encoding";
    }
    return new Response(req.method === "HEAD" ? null : body, { headers: isolated(headers) });
  }

  // The metadata list is the engine's own prefetch list, not a promise that
  // it never asks for anything else, so a file missing from disk comes from
  // the CDN folder the engine was pulled from.
  async function fromCdn(req: Request, relative: string): Promise<Response> {
    let source: unknown;
    try {
      source = JSON.parse(await readFile(resolve(engine, "version.json"), "utf8")).source;
    } catch {
      return notFound();
    }
    if (typeof source !== "string" || !source.startsWith("https://setup.rbxcdn.com/webclient/")) return notFound();
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${source}/${encodeURI(relative)}`, { method: req.method, signal: req.signal });
    } catch {
      return notFound();
    }
    if (!upstream.ok) return notFound();
    const ext = extname(relative).toLowerCase();
    return new Response(req.method === "HEAD" ? null : upstream.body, {
      headers: isolated({
        "content-type": MIME_TYPES[ext] || upstream.headers.get("content-type") || "application/octet-stream",
        "cache-control": "no-cache",
      }),
    });
  }

  return async function handleBlox(req: Request, pathname: string): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: isolated({ allow: "GET, HEAD" }) });
    }
    let relative: string;
    try {
      relative = decodeURIComponent(pathname.slice(BLOX_PREFIX.length));
    } catch {
      return notFound();
    }
    if (relative === "") relative = "index.html";
    if (relative === "epoxy.mjs") return (await serveFile(req, epoxy)) ?? notFound();
    if (Object.hasOwn(HOST_FILES, relative)) return (await serveFile(req, resolve(host, relative))) ?? notFound();
    if (!relative.startsWith("engine/")) return notFound();
    const enginePath = relative.slice("engine/".length);
    if (!ENGINE_PATH.test(enginePath) || enginePath.split("/").some((part) => part === "." || part === "..")) return notFound();
    const path = inside(engine, normalize(enginePath));
    if (!path) return notFound();
    return (await serveFile(req, path)) ?? fromCdn(req, enginePath);
  };
}
