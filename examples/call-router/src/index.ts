import { createRouterServer, WEBHOOK_PATH } from "./app";

const port = Number(process.env.PORT ?? 3000);

const { listen } = createRouterServer();

const { port: boundPort } = await listen(port);
console.log(`Call router example listening on :${boundPort}`);
console.log(`  control plane  POST ${WEBHOOK_PATH}`);
console.log(
  "  (set CALL_ROUTER_BLOCKLIST / CALL_ROUTER_ON_CALL_NUMBER / " +
    "CALL_ROUTER_BUSINESS_HOURS_START / CALL_ROUTER_BUSINESS_HOURS_END to configure routing)"
);
