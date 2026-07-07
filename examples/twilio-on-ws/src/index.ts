import { createCallServer, MEDIA_PATH, WEBHOOK_PATH } from "./app";

const port = Number(process.env.PORT ?? 3000);
// Public URL of this server (e.g. the ngrok https URL). Needed so Twilio
// knows where to dial the media WebSocket; for inbound calls it can also be
// derived from the webhook's Host header, so this is optional.
const publicUrl = process.env.CALL_PUBLIC_URL;

const { listen } = createCallServer({
  twilio: publicUrl
    ? { mediaUrl: `${publicUrl.replace(/^http/, "ws")}${MEDIA_PATH}` }
    : {},
});

const { port: boundPort } = await listen(port);
console.log(`Call SDK example listening on :${boundPort}`);
console.log(`  control plane  POST ${WEBHOOK_PATH}`);
console.log(`  media plane    WS   ${MEDIA_PATH}`);
console.log(
  publicUrl
    ? `  public URL     ${publicUrl}`
    : "  (set CALL_PUBLIC_URL to your public https URL when using a tunnel)"
);
