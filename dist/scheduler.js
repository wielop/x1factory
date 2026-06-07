import { logger } from "./config/logger.js";
import { sendMorningDigests, sendNoonReminders, sendEveningRecaps } from "./services/dailyNotificationService.js";
// Fires fn once the clock reaches targetHour:00 UTC, then every 24h
function scheduleDailyUtc(targetHour, label, fn) {
    function msUntilNext() {
        const now = new Date();
        const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetHour, 0, 0, 0));
        if (next.getTime() <= now.getTime())
            next.setUTCDate(next.getUTCDate() + 1);
        return next.getTime() - now.getTime();
    }
    let interval = null;
    const timeout = setTimeout(() => {
        logger.info(`[scheduler] firing ${label}`);
        void fn().catch(err => logger.error({ err }, `[scheduler] ${label} failed`));
        interval = setInterval(() => {
            logger.info(`[scheduler] firing ${label}`);
            void fn().catch(err => logger.error({ err }, `[scheduler] ${label} failed`));
        }, 24 * 60 * 60 * 1000);
    }, msUntilNext());
    return () => {
        clearTimeout(timeout);
        if (interval)
            clearInterval(interval);
    };
}
export function startScheduler() {
    logger.info("[scheduler] starting daily notification schedule (08:00 / 12:00 / 20:00 UTC)");
    const stops = [
        scheduleDailyUtc(8, "morning digest", sendMorningDigests),
        scheduleDailyUtc(12, "noon reminder", sendNoonReminders),
        scheduleDailyUtc(20, "evening recap", sendEveningRecaps),
    ];
    return () => stops.forEach(s => s());
}
