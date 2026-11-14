import { createReadStream } from "node:fs";
import { configFromEnv, connect, migrate } from "./core.js";
import { bootstrapAdmin, reconcileEbook } from "./operators.js";
const db = connect(configFromEnv());
try {
  await migrate(db);
  if (process.argv[2] === "bootstrap-admin") {
    if (!process.env.ADMIN_PASSWORD_FILE)
      throw new Error("ADMIN_PASSWORD_FILE is required");
    const input =
      process.env.ADMIN_PASSWORD_FILE === "/dev/stdin"
        ? process.stdin
        : createReadStream(process.env.ADMIN_PASSWORD_FILE);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024) {
        input.destroy();
        throw new Error("Bootstrap password input exceeds 1024 bytes");
      }
      chunks.push(bytes);
    }
    const password = Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    await bootstrapAdmin(db, {
      email: process.env.ADMIN_EMAIL,
      name: process.env.ADMIN_NAME || "Administrator",
      password,
    });
    console.log(
      "Administrator created. Remove the bootstrap password secret from the environment.",
    );
  } else if (process.argv[2] === "reconcile-ebook") {
    await reconcileEbook(
      db,
      process.argv[3],
      process.argv[4] as "delivered" | "not-delivered",
    );
    console.log("Delivery outcome reconciled.");
  } else
    throw new Error(
      "Use bootstrap-admin or reconcile-ebook <ebook UUID> delivered|not-delivered",
    );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Operator command failed",
  );
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 });
}
