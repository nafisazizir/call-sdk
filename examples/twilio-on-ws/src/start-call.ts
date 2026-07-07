// Places an outbound call: pnpm start-call +614xxxxxxxx
// Requires CALL_PUBLIC_URL (Twilio must be able to dial our media socket).
import { createCallServer, MEDIA_PATH } from "./app";

const to = process.argv[2];
if (!to) {
  console.error("usage: pnpm start-call <E.164 phone number>");
  process.exit(1);
}
const publicUrl = process.env.CALL_PUBLIC_URL;
if (!publicUrl) {
  console.error("CALL_PUBLIC_URL must be set for outbound calls");
  process.exit(1);
}

const { call, listen } = createCallServer({
  twilio: { mediaUrl: `${publicUrl.replace(/^http/, "ws")}${MEDIA_PATH}` },
});
const server = await listen(Number(process.env.PORT ?? 3000));

console.log(`Dialing ${to}...`);
const session = await call.dial({ adapter: "twilio", to });
console.log(`Live: ${session.id}`);
const ended = await session.ended;
console.log(`Call ended (${ended.reason})`);
await server.close();
