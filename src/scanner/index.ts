import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

import { runScannerCycle } from "./service.js";

export function startScanner(): () => void {
  const run = async (): Promise<void> => {
    try {
      await runScannerCycle({
        adapterMode: env.x1FactoryAdapter
      });
    } catch (error) {
      logger.error({ error }, "Scanner cycle failed");
    }
  };

  void run();

  const timer = setInterval(() => {
    void run();
  }, env.scannerIntervalMs);

  logger.info(
    { intervalMs: env.scannerIntervalMs, adapterMode: env.x1FactoryAdapter },
    "X1Factory scanner started"
  );

  return () => {
    clearInterval(timer);
    logger.info("X1Factory scanner stopped");
  };
}
