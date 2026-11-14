import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { Readable } from "node:stream";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { ApiFailure } from "./core.js";

export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
export interface FetchResult {
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
export class SafeFetcher {
  constructor(
    readonly allowHosts: string[] = [],
    readonly resolveHost: (
      host: string,
    ) => Promise<{ address: string; family: number }[]> = (host) =>
      lookup(host, { all: true, verbatim: true }),
  ) {}
  validate(input: string): URL {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new ApiFailure(
        400,
        "INVALID_URL",
        "A valid HTTP(S) URL is required",
      );
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 4096 ||
      host.includes("%")
    ) {
      throw new ApiFailure(
        400,
        "UNSAFE_URL",
        "URL scheme, credentials or host are not allowed",
      );
    }
    if (
      !this.allowHosts.includes(host) &&
      url.port &&
      !["80", "443"].includes(url.port)
    )
      throw new ApiFailure(
        400,
        "UNSAFE_URL",
        "Only standard HTTP(S) ports are allowed",
      );
    url.hash = "";
    return url;
  }
  async fetch(
    input: string,
    options: {
      maxBytes?: number;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<FetchResult> {
    const deadline = Date.now() + (options.timeoutMs ?? 15000);
    let current = input;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const url = this.validate(current),
        host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      const remaining = () => Math.max(1, deadline - Date.now());
      if (Date.now() >= deadline)
        throw new ApiFailure(
          504,
          "FETCH_TIMEOUT",
          "Upstream request timed out",
        );
      let timer: NodeJS.Timeout | undefined;
      let addresses: { address: string; family: number }[];
      try {
        addresses = isIP(host)
          ? [{ address: host, family: isIP(host) }]
          : await Promise.race([
              this.resolveHost(host),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new ApiFailure(
                        504,
                        "FETCH_TIMEOUT",
                        "DNS lookup timed out",
                      ),
                    ),
                  remaining(),
                );
              }),
            ]);
      } catch (error) {
        throw error instanceof ApiFailure
          ? error
          : new ApiFailure(502, "FETCH_DNS", "Upstream DNS lookup failed");
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (
        !addresses.length ||
        (!this.allowHosts.includes(host) &&
          addresses.some((a) => !publicAddress(a.address)))
      )
        throw new ApiFailure(
          400,
          "SSRF_BLOCKED",
          "This network address is not permitted",
        );
      const address = addresses[0];
      const response = await new Promise<FetchResult>((resolve, reject) => {
        const request = (url.protocol === "https:" ? https : http).request(
          url,
          {
            method: "GET",
            agent: false,
            // Keep Host/SNI from URL but connect only to the already validated address.
            lookup: ((_hostname: string, lookupOptions: any, cb: any) =>
              lookupOptions.all
                ? cb(null, [address])
                : cb(null, address.address, address.family)) as any,
            headers: {
              "User-Agent": "FeedInk/0.1 (+self-hosted RSS archive)",
              Accept: "*/*",
              "Accept-Encoding": "gzip, br, deflate",
              ...options.headers,
            },
          },
          (res) => {
            const status = res.statusCode ?? 502;
            if ([301, 302, 303, 307, 308].includes(status)) {
              res.destroy();
              resolve({
                url: url.href,
                status,
                headers: res.headers,
                body: Buffer.alloc(0),
              });
              return;
            }
            const length = Number(res.headers["content-length"] || 0),
              max = options.maxBytes ?? 4 * 1024 * 1024;
            if (length > max) {
              res.destroy();
              reject(
                new ApiFailure(
                  502,
                  "FETCH_SIZE",
                  "Upstream encoded body is too large",
                ),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > max) {
                res.destroy(
                  new ApiFailure(
                    502,
                    "FETCH_SIZE",
                    "Upstream body exceeds the size limit",
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () =>
              resolve({
                url: url.href,
                status,
                headers: res.headers,
                body: Buffer.concat(chunks),
              }),
            );
            res.on("error", reject);
          },
        );
        const timeout = setTimeout(
          () =>
            request.destroy(
              new ApiFailure(
                504,
                "FETCH_TIMEOUT",
                "Upstream request timed out",
              ),
            ),
          remaining(),
        );
        request.on("close", () => clearTimeout(timeout));
        request.on("error", (error) =>
          reject(
            error instanceof ApiFailure
              ? error
              : new ApiFailure(
                  502,
                  "FETCH_FAILED",
                  "Could not connect to the upstream server",
                ),
          ),
        );
        request.end();
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location || redirects === 5)
          throw new ApiFailure(
            502,
            "FETCH_REDIRECT",
            "Too many or invalid upstream redirects",
          );
        current = new URL(response.headers.location, url).href;
        // Never forward conditional headers or a source Referer across redirects.
        options = { ...options, headers: {} };
        continue;
      }
      if (
        response.body.length &&
        response.headers["content-encoding"] &&
        response.headers["content-encoding"] !== "identity"
      ) {
        response.body = await decodeBody(
          response.body,
          String(response.headers["content-encoding"]),
          options.maxBytes ?? 4 * 1024 * 1024,
          deadline,
        );
      }
      return response;
    }
    throw new ApiFailure(502, "FETCH_REDIRECT", "Too many upstream redirects");
  }
}
export async function decodeBody(
  body: Buffer,
  encoding: string,
  maxBytes: number,
  deadline: number,
): Promise<Buffer> {
  if (Date.now() >= deadline)
    throw new ApiFailure(504, "FETCH_TIMEOUT", "Upstream decoding timed out");
  const decoder =
    encoding === "gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : null;
  if (!decoder)
    throw new ApiFailure(
      502,
      "FETCH_ENCODING",
      "Unsupported upstream content encoding",
    );
  return new Promise((resolve, reject) => {
    const source = Readable.from(body),
      chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(
      () =>
        decoder.destroy(
          new ApiFailure(504, "FETCH_TIMEOUT", "Upstream decoding timed out"),
        ),
      Math.max(1, deadline - Date.now()),
    );
    decoder.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes)
        decoder.destroy(
          new ApiFailure(
            502,
            "FETCH_SIZE",
            "Decoded upstream body exceeds the size limit",
          ),
        );
      else chunks.push(chunk);
    });
    decoder.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    decoder.on("error", (error) => {
      clearTimeout(timer);
      source.destroy();
      reject(
        error instanceof ApiFailure
          ? error
          : new ApiFailure(
              502,
              "FETCH_ENCODING",
              "Invalid compressed upstream body",
            ),
      );
    });
    source.pipe(decoder);
  });
}
export function requireOk(result: FetchResult) {
  if (result.status < 200 || result.status >= 300)
    throw new ApiFailure(
      502,
      "UPSTREAM_STATUS",
      `Upstream returned HTTP ${result.status}`,
    );
  return result;
}
