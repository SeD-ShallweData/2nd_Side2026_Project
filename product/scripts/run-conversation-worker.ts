// Run the bundled server entry with: node .runtime/conversation-worker.mjs
import { runConversationMaintenance } from "../src/services/conversationMaintenanceService";
import { closeWritePools } from "../src/server/postgresWrite";

try {
  const result = await runConversationMaintenance();
  console.log(JSON.stringify(result)); // counts/version only; no IDs, text, tokens or connection URLs
  if (result.failed) process.exitCode = 1;
} catch {
  console.error("CONVERSATION_MAINTENANCE_FAILED");
  process.exitCode = 1;
} finally {
  await closeWritePools();
}
