import "dotenv/config";
import { runAgentTurn } from "./conversationalAgent";

async function main() {
  const eventId = "synthetic_acb3dac8-12f9-4e19-bdba-7ed4f74d0cd4"; // expired_card event from batch_1
  const customerEmail = "customer3@example.com";
  const amount = 33447;

  const reply1 = await runAgentTurn(eventId, customerEmail, amount, "Hi, my payment didn't go through. My card must have expired.");
  console.log("Agent:", reply1);

  const reply2 = await runAgentTurn(eventId, customerEmail, amount, "Yeah can I pay a different way instead?");
  console.log("Agent:", reply2);
}

main().catch((err) => {
  console.error("Conversation failed:", err);
  process.exitCode = 1;
});