import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { HttpError } from "@/lib/errors";

export type ActionState = { error?: string; ok?: boolean; id?: string };

/** A client-safe form error, or null when the caller should rethrow. */
export function actionFailure(err: unknown): { error: string } | null {
  if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Check the form and try again." };
  if (err instanceof UnauthorizedError) return { error: "Sign in to continue." };
  if (err instanceof ForbiddenError) return { error: "You don't have permission to do that." };
  if (err instanceof HttpError && err.status < 500) return { error: err.message };
  return null;
}
