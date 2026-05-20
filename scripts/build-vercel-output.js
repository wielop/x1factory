import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const outputRoot = resolve(root, ".vercel", "output");
const staticRoot = resolve(outputRoot, "static");
const publicRoot = resolve(root, "public");

rmSync(outputRoot, { recursive: true, force: true });
rmSync(publicRoot, { recursive: true, force: true });
mkdirSync(staticRoot, { recursive: true });
mkdirSync(publicRoot, { recursive: true });
cpSync(resolve(root, "web"), staticRoot, { recursive: true });
cpSync(resolve(root, "web"), publicRoot, { recursive: true });
mkdirSync(resolve(publicRoot, "telegrambot"), { recursive: true });
mkdirSync(resolve(publicRoot, "reactor"), { recursive: true });
cpSync(resolve(root, "web", "reactor.html"), resolve(publicRoot, "index.html"));
cpSync(resolve(root, "web", "reactor.html"), resolve(publicRoot, "telegrambot", "index.html"));
cpSync(resolve(root, "web", "reactor.html"), resolve(publicRoot, "reactor", "index.html"));

writeFileSync(
  resolve(outputRoot, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/telegrambot", dest: "/reactor.html" },
        { src: "/reactor", dest: "/reactor.html" },
        { handle: "filesystem" },
        { src: "/", dest: "/reactor.html" }
      ]
    },
    null,
    2
  )
);
