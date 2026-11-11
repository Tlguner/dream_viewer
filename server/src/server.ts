import { app, defaultAppInstance, formatMixedModeWarning } from './app.js';
import { ComfyDreamProvider } from './providers/comfy_provider.js';

const PORT = parseInt(process.env.PORT || '5000', 10);
const HOST = process.env.HOST || '127.0.0.1';

let server: ReturnType<typeof app.listen> | undefined;

async function startServer() {
  if (defaultAppInstance.dreamProvider instanceof ComfyDreamProvider) {
    await defaultAppInstance.dreamProvider.verifyKeyframeModel();
  }

  server = app.listen(PORT, HOST, () => {
    console.log(`✨ Dream Viewer Server active on http://${HOST}:${PORT}`);
    console.log(`🔒 4-Layer Moderation Shield & Provider Active`);
    console.log(`📦 Credit Ledger & Asynchronous Queue Active`);
    const archModel = defaultAppInstance.dreamArchitect.model
      ? ` (${defaultAppInstance.dreamArchitect.model})`
      : '';
    console.log(`🧠 Architect Active: ${defaultAppInstance.dreamArchitect.name}${archModel}`);

    const mixedWarning = formatMixedModeWarning(
      defaultAppInstance.dreamProvider,
      defaultAppInstance.dreamArchitect
    );
    if (mixedWarning) {
      console.warn(mixedWarning);
    }
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} signal received: closing HTTP server`);
    if (server) {
      server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

export const serverPromise = startServer().catch((err) => {
  console.error(`❌ [CRITICAL STARTUP ERROR] ${err.message}`);
  process.exit(1);
});

export { server };
