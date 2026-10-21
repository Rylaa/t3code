import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}
