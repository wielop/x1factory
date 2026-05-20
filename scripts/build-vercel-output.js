import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const outputRoot = resolve(root, ".vercel", "output");
const staticRoot = resolve(outputRoot, "static");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(staticRoot, { recursive: true });
cpSync(resolve(root, "web"), staticRoot, { recursive: true });

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
