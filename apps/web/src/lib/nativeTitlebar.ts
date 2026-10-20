import { isElectron } from "~/env";

// The workspace topbar the desktop app centers the traffic lights in; the lights
// stay inside it at any zoom level.
export const NATIVE_TITLEBAR_HEIGHT = isElectron ? 52 : 0;
