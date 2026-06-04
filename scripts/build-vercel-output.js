import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const outputRoot = resolve(root, ".vercel", "output");
const staticRoot = resolve(outputRoot, "static");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(staticRoot, { recursive: true });
cpSync(resolve(root, "web"), staticRoot, { recursive: true });

// /panel → panel/index.html
mkdirSync(resolve(staticRoot, "panel"), { recursive: true });
cpSync(resolve(root, "web", "panel.html"), resolve(staticRoot, "panel", "index.html"));

writeFileSync(
  resolve(outputRoot, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/panel", dest: "/panel/index.html" },
        { handle: "filesystem" }
      ]
    },
    null,
    2
  )
);

if (!existsSync(resolve(staticRoot, "panel", "index.html"))) {
  throw new Error("Vercel static build failed to create .vercel/output/static/panel/index.html");
}

console.log("Vercel Build Output API ready: .vercel/output/");
