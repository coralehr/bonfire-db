import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("./dist", import.meta.url)));
const host = process.env.BONFIRE_DEMO_HOST ?? "127.0.0.1";
const port = Number(process.env.BONFIRE_DEMO_PORT ?? "5173");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"]
]);

export function isInsideRoot(filePath, rootDir = root) {
  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(filePath);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

export function resolvePath(url, rootDir = root) {
  const pathname = new URL(url, `http://${host}:${port}`).pathname;
  const requested = (pathname === "/" ? "/index.html" : pathname).replace(/^\/+/, "");
  const fallback = resolve(rootDir, "index.html");
  const filePath = resolve(rootDir, requested);

  if (!isInsideRoot(filePath, rootDir)) return fallback;
  if (existsSync(filePath)) return filePath;
  return fallback;
}

export function createDemoServer() {
  return createServer((request, response) => {
    const filePath = resolvePath(request.url ?? "/");
    response.setHeader("Content-Type", contentTypes.get(extname(filePath)) ?? "application/octet-stream");
    createReadStream(filePath)
      .on("error", () => {
        response.statusCode = 404;
        response.end("not found");
      })
      .pipe(response);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createDemoServer().listen(port, host, () => {
    console.log(`bonfire demo listening on http://${host}:${port}`);
  });
}
