import { createApp } from "./app.js";
import { configFromEnv } from "./core.js";
const config = configFromEnv();
const { app } = await createApp(config);
await app.listen({ host: config.host, port: config.port });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
