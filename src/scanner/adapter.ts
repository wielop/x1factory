import type { IX1FactoryAdapter } from "./types.js";
import { MockX1FactoryAdapter } from "./mockAdapter.js";
import { RpcX1FactoryAdapter } from "./rpcAdapter.js";

export function createX1FactoryAdapter(mode: string): IX1FactoryAdapter {
  if (mode === "rpc") {
    return new RpcX1FactoryAdapter();
  }

  return new MockX1FactoryAdapter();
}
