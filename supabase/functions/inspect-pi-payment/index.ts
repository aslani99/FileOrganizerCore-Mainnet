import { serviceClient } from "../_shared/helpers.ts";
import { createInspector } from "./handler.mjs";
Deno.serve(createInspector({client:serviceClient(),env:(name:string)=>Deno.env.get(name)}));
