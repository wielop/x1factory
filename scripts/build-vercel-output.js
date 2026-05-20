import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const publicRoot = resolve(root, "public");

rmSync(publicRoot, { recursive: true, force: true });
mkdirSync(publicRoot, { recursive: true });
cpSync(resolve(root, "web"), publicRoot, { recursive: true });
mkdirSync(resolve(publicRoot, "telegrambot"), { recursive: true });
mkdirSync(resolve(publicRoot, "reactor"), { recursive: true });
cpSync(resolve(root, "web", "reactor.html"), resolve(publicRoot, "index.html"));
cpSync(resolve(root, "web", "reactor.html"), resolve(publicRoot, "telegrambot", "index.html"));
cpSync(resolve(root, "web", "reactor.html"), resolve(publicRoot, "reactor", "index.html"));

if (!existsSync(resolve(publicRoot, "telegrambot", "index.html"))) {
  throw new Error("Vercel static build failed to create public/telegrambot/index.html");
}

console.log("Vercel static output ready: public/");
