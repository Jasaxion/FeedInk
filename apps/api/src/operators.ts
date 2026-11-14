import { z } from "zod";
import { type DB, id, ApiFailure } from "./core.js";
import { passwordHash } from "./auth.js";

export async function bootstrapAdmin(db: DB, input: unknown) {
  const values = z
    .object({
      email: z
        .email()
        .max(254)
        .transform((s) => s.toLowerCase()),
      name: z.string().trim().min(1).max(160),
      password: z.string().min(10).max(256),
    })
    .strict()
    .parse(input);
  const digest = await passwordHash(values.password);
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(71244003)`;
    if (
      (
        await tx`SELECT id FROM users WHERE email=${values.email} OR (is_admin AND NOT disabled) LIMIT 1`
      ).length
    )
      throw new ApiFailure(
        409,
        "BOOTSTRAP_REFUSED",
        "Bootstrap requires an unused email and no active administrator; existing accounts are never elevated",
      );
    const [user] =
      await tx`INSERT INTO users(id,email,name,password_hash,is_admin) VALUES(${id()},${values.email},${values.name},${digest},true) RETURNING id`;
    return user.id as string;
  });
}
export async function reconcileEbook(
  db: DB,
  ebookId: string,
  outcome: "delivered" | "not-delivered",
) {
  z.uuid().parse(ebookId);
  z.enum(["delivered", "not-delivered"]).parse(outcome);
  return db.begin(async (tx) => {
    const [book] = await tx`SELECT user_id FROM ebooks WHERE id=${ebookId}`;
    if (!book) throw new ApiFailure(404, "NOT_FOUND", "Ebook not found");
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${book.user_id},3))`;
    const changed =
      await tx`UPDATE ebooks SET delivery_state=${outcome === "delivered" ? "sent" : "not_delivered"},sent_at=${outcome === "delivered" ? new Date() : null},error=${outcome === "delivered" ? null : "Operator confirmed not delivered; eligible for a later scheduled retry"} WHERE id=${ebookId} AND delivery_state IN ('sending','unknown') RETURNING id`;
    if (!changed.length)
      throw new ApiFailure(
        409,
        "RECONCILE_REFUSED",
        "Only sending/unknown delivery outcomes can be reconciled",
      );
  });
}
