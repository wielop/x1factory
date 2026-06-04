import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const outputRoot = resolve(root, ".vercel", "output");
const staticRoot = resolve(outputRoot, "static");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(staticRoot, { recursive: true });
cpSync(resolve(root, "web"), staticRoot, { recursive: true });
mkdirSync(resolve(staticRoot, "telegrambot"), { recursive: true });
mkdirSync(resolve(staticRoot, "reactor"), { recursive: true });
cpSync(resolve(root, "web", "reactor.html"), resolve(staticRoot, "index.html"));
cpSync(resolve(root, "web", "reactor.html"), resolve(staticRoot, "telegrambot", "index.html"));
cpSync(resolve(root, "web", "reactor.html"), resolve(staticRoot, "reactor", "index.html"));

writeFileSync(
  resolve(outputRoot, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/telegrambot", dest: "/telegrambot/index.html" },
        { src: "/reactor", dest: "/reactor/index.html" },
        { handle: "filesystem" },
        { src: "/", dest: "/index.html" }
      ]
    },
    null,
    2
  )
);

if (!existsSync(resolve(staticRoot, "telegrambot", "index.html"))) {
  throw new Error("Vercel static build failed to create .vercel/output/static/telegrambot/index.html");
}

console.log("Vercel Build Output API ready: .vercel/output/");
