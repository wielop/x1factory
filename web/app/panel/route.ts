import { readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

export function GET() {
  const html = readFileSync(join(process.cwd(), "public", "panel.html"), "utf-8");
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
