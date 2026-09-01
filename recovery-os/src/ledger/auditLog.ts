import { Pool } from "pg";

const pool = new Pool();

export async function logAuditEvent(eventId: string, stage: string, detail: object): Promise<void> {
  await pool.query(
    "INSERT INTO audit_log (event_id, stage, detail) VALUES ($1, $2, $3)",
    [eventId, stage, JSON.stringify(detail)]
  );
}