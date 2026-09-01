import "dotenv/config";
import { runAgentTurn } from "./conversationalAgent";

async function main() {
  const eventId = "synthetic_32a03053-0326-49ad-b29c-2d846b1c5599"; // insufficient_funds, whatsapp_nudge
  const reply = await runAgentTurn(eventId, "customer1@example.com", 26030, "Yeah I think I need to add funds first, can you check if there's anything blocking my account?");
  console.log("Agent:", reply);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});