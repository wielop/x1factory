import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const outputRoot = resolve(root, "dist-vercel");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
cpSync(resolve(root, "web"), outputRoot, { recursive: true });
mkdirSync(resolve(outputRoot, "telegrambot"), { recursive: true });
mkdirSync(resolve(outputRoot, "reactor"), { recursive: true });
cpSync(resolve(root, "web", "reactor.html"), resolve(outputRoot, "index.html"));
cpSync(resolve(root, "web", "reactor.html"), resolve(outputRoot, "telegrambot", "index.html"));
cpSync(resolve(root, "web", "reactor.html"), resolve(outputRoot, "reactor", "index.html"));

if (!existsSync(resolve(outputRoot, "telegrambot", "index.html"))) {
  throw new Error("Vercel static build failed to create dist-vercel/telegrambot/index.html");
}

console.log("Vercel static output ready: dist-vercel/");
