import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { HttpError, NotFoundError, VersionConflictError } from "@/lib/errors";

export type ActionState = { error?: string; ok?: boolean; id?: string; conflict?: boolean };

export function read(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

export function versionOf(form: FormData): number | null {
  const version = Number(read(form, "version"));
  return Number.isInteger(version) && version >= 1 ? version : null;
}

/** A validation message that names the field, so a long form says which input to fix. */
export function zodMessage(err: ZodError, labels: Record<string, string> = {}): string {
  const issue = err.issues[0];
  if (!issue) return "Check the form and try again.";
  const key = String(issue.path[0] ?? "");
  const label = labels[key];
  if (!label) return issue.message;
  return issue.message.toLowerCase().startsWith(label.toLowerCase()) ? issue.message : `${label}: ${issue.message}`;
}

/** Turn a data-layer error into a sentence for `role="alert"`. Unexpected errors are rethrown. */
export function actionFailure(err: unknown, labels: Record<string, string> = {}): ActionState {
  if (err instanceof ZodError) {
    const message = zodMessage(err, labels);
    if (message.includes("12 hours") || message.toLowerCase().includes("scheduled")) {
      return { error: "Give a start and an end, with the end after the start and at most 12 hours later." };
    }
    return { error: message };
  }
  if (err instanceof VersionConflictError) {
    return {
      error: "Someone else changed this. The latest version was reloaded. Review it and try again.",
      conflict: true,
    };
  }
  if (err instanceof UnauthorizedError) return { error: "Sign in to continue." };
  if (err instanceof ForbiddenError) return { error: "You don't have access to do that." };
  if (err instanceof HttpError && err.status < 500) {
    if (err.status === 429) return { error: "Too many requests. Try again in a minute." };
    if (err.message === "Assignee must be a technician") return { error: "Choose an active technician." };
    if (err.message === "A scheduled window is required when assigning a technician") {
      return { error: "Add a start and an end before assigning. The window can be at most 12 hours." };
    }
    return { error: err.message };
  }
  throw err;
}

/** A failed page read: `"missing"` is a 404 (or a bad id); a string is safe to show; anything else is rethrown. */
export function readFailure(err: unknown): "missing" | string {
  if (err instanceof NotFoundError || err instanceof ZodError) return "missing";
  if (err instanceof HttpError && err.status === 429) return "Too many requests. Try again in a minute.";
  throw err;
}
