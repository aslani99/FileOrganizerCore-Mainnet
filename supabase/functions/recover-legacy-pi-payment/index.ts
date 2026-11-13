import { serviceClient } from "../_shared/helpers.ts";
import { createLegacyRecovery } from "./handler.mjs";
Deno.serve(createLegacyRecovery({client:serviceClient(),env:(name:string)=>Deno.env.get(name)}));
