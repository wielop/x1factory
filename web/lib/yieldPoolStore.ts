import fs from "fs";
import path from "path";

// Simple file-backed store for weekly yield pool override.
// Uses a JSON file under /data to persist across restarts on stateful hosts.

type Stored = { value: number; updatedAt: number };
const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "yield-pool.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getStoredPoolXnt(): Stored | null {
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Stored;
    if (!Number.isFinite(parsed.value)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setStoredPoolXnt(value: number): Stored {
  ensureDataDir();
  const stored: Stored = { value, updatedAt: Date.now() };
  fs.writeFileSync(FILE_PATH, JSON.stringify(stored), "utf8");
  return stored;
}
