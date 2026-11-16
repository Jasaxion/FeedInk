import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Readable } from "node:stream";
import { privateBlobStream } from "../src/storage/stream.js";

for (const afterBytes of [false, true]) {
  test(`privateBlobStream closes and masks ${afterBytes ? "mid-body" : "early"} backend failures`, async () => {
    let started = false;
    const source = new Readable({ read() {
      if (started) return; started = true;
      if (afterBytes) this.push(Buffer.from("prefix"));
      setImmediate(() => this.destroy(Object.assign(new Error("raw synthetic backend message"), { code: "raw-code", endpoint: "raw-endpoint" })));
    } });
    const closed = new Promise<void>(resolve => source.once("close", resolve));
    await assert.rejects(async () => {
      for await (const _chunk of privateBlobStream(source)) { /* consume */ }
    }, (error: any) => error.message === "Private blob read failed" && !error.code && !error.cause && !error.endpoint);
    await closed; assert.equal(source.destroyed, true);
  });
}

test("privateBlobStream cancellation before the first read still closes its owned source", async () => {
  const source = new Readable({ read() {} }), output = privateBlobStream(source), closed = once(source, "close");
  output.destroy(); await closed; assert.equal(source.destroyed, true);
});
