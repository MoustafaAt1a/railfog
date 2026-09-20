import { resolve, toFileUrl } from "@std/path";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
export * from "./context-builder.ts";
import { RailFogContext } from "./context-builder.ts";

export interface LoadedFunction {
  handler: (req: Request, ctx: RailFogContext) => Promise<Response>;
}

const cache = new Map<string, LoadedFunction>();

/**
 * Spec references:
 * - FN-1: Function definition
 * - FN-3: Lifecycle / Revision caching
 * - FN-6: Isolation & warm-reuse rule
 */
export async function loadFunction(
  entry: string,
  options?: { revision?: string } | string,
): Promise<LoadedFunction> {
  const revision = typeof options === "string"
    ? options
    : options?.revision ?? "latest";
  const resolvedPath = resolve(entry);
  const cacheKey = `${resolvedPath}:${revision}`;

  try {
    await Deno.stat(resolvedPath);
  } catch {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Function file not found: " + entry,
    );
  }

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  const url = toFileUrl(resolvedPath).href;
  const mod = await import(url);

  if (!mod || typeof mod.default !== "function") {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Function module must export a default handler function",
    );
  }

  const loaded: LoadedFunction = { handler: mod.default };
  cache.set(cacheKey, loaded);
  return loaded;
}
