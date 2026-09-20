import type { RailFogContext } from "../../../runtime/loader/function-loader.ts";

export default async function handler(
  _req: Request,
  _ctx: RailFogContext,
): Promise<Response> {
  await Promise.resolve();
  return new Response("OK");
}
