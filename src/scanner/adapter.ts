import type { IX1FactoryAdapter } from "./types.js";
import { RealX1FactoryAdapter } from "./realAdapter.js";

export function createX1FactoryAdapter(): IX1FactoryAdapter {
  return new RealX1FactoryAdapter();
}
