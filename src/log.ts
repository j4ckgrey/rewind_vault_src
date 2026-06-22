/**
 * @vault/log — logger shim. Forwards to the host logger (console fallback before
 * a host is registered). Keeps the adult code's `logger.x("adult", …)` calls
 * unchanged.
 */
import { getVaultHost, hasVaultHost, type VaultLogger } from "@vault/host";

const consoleLogger: VaultLogger = {
  info: (c, m) => console.log(`[${c}] ${m}`),
  success: (c, m) => console.log(`[${c}] ${m}`),
  warn: (c, m) => console.warn(`[${c}] ${m}`),
  error: (c, m, e) => console.error(`[${c}] ${m}`, e ?? ""),
};

function sink(): VaultLogger {
  return hasVaultHost() ? getVaultHost().logger : consoleLogger;
}

export const logger: VaultLogger = {
  info: (c, m) => sink().info(c, m),
  success: (c, m) => sink().success(c, m),
  warn: (c, m) => sink().warn(c, m),
  error: (c, m, e) => sink().error(c, m, e),
};
