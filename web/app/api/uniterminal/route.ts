const DEFAULT_UNITERMINAL_URL = "https://apiv5.uniterminal.xyz/v1/config/ext_config";
const DEFAULT_VERSION = "5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function resolveTargetUrl(req: Request): string {
  const baseUrl = (process.env.UNITERMINAL_URL ?? DEFAULT_UNITERMINAL_URL).trim();
  const target = new URL(baseUrl);
  const { searchParams } = new URL(req.url);
  for (const [key, value] of searchParams.entries()) {
    target.searchParams.set(key, value);
  }
  if (!target.searchParams.has("version")) {
    target.searchParams.set("version", DEFAULT_VERSION);
  }
  return target.toString();
}

export async function GET(req: Request) {
  try {
    const targetUrl = resolveTargetUrl(req);
    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers: { "User-Agent": "x1mining-client" },
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
}

export function OPTIONS() {
  return new Response(null, { headers: corsHeaders, status: 204 });
}
