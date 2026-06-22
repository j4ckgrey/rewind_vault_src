/**
 * @vault/scanner — delegating shim for the ffprobe helpers the adult code uses
 * (duration + stream-info chip). Forwards to the registered host.
 */
import { getVaultHost, type VaultHost } from "@vault/host";

export const probeFile: VaultHost["probeFile"] = (filePath, httpHeaders) =>
  getVaultHost().probeFile(filePath, httpHeaders);

export const parseProbeInfo: VaultHost["parseProbeInfo"] = (probe) =>
  getVaultHost().parseProbeInfo(probe);
