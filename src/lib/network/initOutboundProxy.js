import { getSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";

let initialized = false;

export async function ensureOutboundProxyInitialized() {
  if (initialized) return true;

  try {
    const settings = await getSettings();
    applyOutboundProxyEnv(settings);
    initialized = true;
  } catch (error) {
    console.error("[ServerInit] Error initializing outbound proxy:", error);
  }

  return initialized;
}

// Defer init so HTTP server accepts connections first. Skipped while
// `next build` prerenders pages: every build worker imports the root layout,
// and with a remote PostgreSQL database each one would open a connection and
// race to create the schema. Runtime requests still initialize on first use.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
if (!isBuildPhase) {
  setImmediate(() => {
    ensureOutboundProxyInitialized().catch(console.log);
  });
}

export default ensureOutboundProxyInitialized;
