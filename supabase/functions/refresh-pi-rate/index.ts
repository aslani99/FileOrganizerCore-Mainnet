import { serviceClient } from "../_shared/helpers.ts";
import { createRateHandler } from "./handler.mjs";
Deno.serve(createRateHandler({ client: serviceClient(), env: (name: string) => Deno.env.get(name) }));
