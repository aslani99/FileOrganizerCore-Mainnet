import { serviceClient } from "../_shared/helpers.ts";
import { createPaymentHandler } from "../_shared/payment-handlers.mjs";
Deno.serve(createPaymentHandler('cancel', {client:serviceClient(),env:(name:string)=>Deno.env.get(name)}));
