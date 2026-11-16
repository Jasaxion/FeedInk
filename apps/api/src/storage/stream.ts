import { Readable } from "node:stream";

/** The HTTP-facing stream never forwards backend error metadata, and owns its source lifetime. */
export function privateBlobStream(source: Readable): Readable {
  // A backend can fail before the HTTP consumer attaches. Keep that error handled; its iterator
  // still observes the failure, which is replaced below without message, code, cause or endpoint.
  const observeError = () => {};
  source.on("error", observeError);
  source.once("close", () => source.off("error", observeError));
  const output: Readable = Readable.from((async function* () {
    try {
      for await (const chunk of source) yield chunk;
    } catch {
      if (!output.destroyed) throw new Error("Private blob read failed");
    } finally {
      source.destroy();
    }
  })(), { objectMode: false });
  const destroyIterator = output._destroy;
  output._destroy = function (error, callback) {
    // Iterator cleanup queues behind a pending read. Cancel its source before awaiting it.
    source.destroy();
    destroyIterator.call(this, error, callback);
  };
  return output;
}
