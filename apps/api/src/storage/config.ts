export type StorageConfig =
  | { backend: "filesystem" }
  | {
      backend: "s3";
      bucket: string;
      region: string;
      endpoint?: string;
      prefix?: string;
      forcePathStyle?: boolean;
      // Only for explicitly configured private/test deployments, never request input.
      allowHttp?: boolean;
    };

export function validateStorageConfig(config?: StorageConfig): StorageConfig {
  if (!config || config.backend === "filesystem") return { backend: "filesystem" };
  if (config.backend !== "s3" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !config.region)
    throw new Error("Invalid storage deployment configuration");
  const prefix = config.prefix || "";
  if (prefix && (!/^[a-zA-Z0-9/_-]+$/.test(prefix) || prefix.startsWith("/") || !prefix.endsWith("/") || prefix.includes("//")))
    throw new Error("S3 prefix must be a relative directory ending in /");
  if (config.endpoint) {
    const endpoint = new URL(config.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
        !(endpoint.protocol === "https:" || (config.allowHttp === true && endpoint.protocol === "http:")))
      throw new Error("S3 endpoint must be HTTPS (HTTP requires explicit private deployment opt-in)");
  }
  return { ...config, prefix };
}

/** Credentials use the official SDK deployment credential chain, never public API inputs. */
export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env, prefix = "STORAGE_"): StorageConfig | undefined {
  const backend = env[`${prefix}BACKEND`];
  if (!backend || backend === "filesystem") return backend ? { backend } : undefined;
  if (backend !== "s3") throw new Error("Unsupported storage backend");
  return validateStorageConfig({
    backend,
    bucket: env[`${prefix}S3_BUCKET`] || "",
    region: env[`${prefix}S3_REGION`] || "us-east-1",
    endpoint: env[`${prefix}S3_ENDPOINT`] || undefined,
    prefix: env[`${prefix}S3_PREFIX`] || "",
    forcePathStyle: env[`${prefix}S3_FORCE_PATH_STYLE`] === "true",
    allowHttp: env[`${prefix}S3_ALLOW_HTTP`] === "true",
  });
}
