import "dotenv/config";
import express, { Request, Response } from "express";
import { Pool } from "pg";

const app = express();
app.use(express.json());

const pool = new Pool(); // reads PGUSER, PGHOST, PGDATABASE, PGPASSWORD, PGPORT from .env automatically

app.post("/webhooks/razorpay", async (req: Request, res: Response) => {
  const eventId = req.headers["x-razorpay-event-id"] as string | undefined;
  const eventType = req.body.event;

  if (!eventId) {
    console.log("Rejected: missing x-razorpay-event-id header");
    res.status(400).send("Missing event id");
    return;
  }

  try {
    await pool.query(
      "INSERT INTO events (event_id, event_type, payload) VALUES ($1, $2, $3)",
      [eventId, eventType, req.body]
    );
    console.log(`Stored new event: ${eventId} (${eventType})`);
    res.status(200).send("OK");
  } catch (err: any) {
    if (err.code === "23505") {
      console.log(`Duplicate event ignored: ${eventId}`);
      res.status(200).send("Already processed");
      return;
    }
    console.error("DB error:", err.message);
    res.status(500).send("Internal error");
  }
});

app.listen(3000, () => {
  console.log("Server listening on http://localhost:3000");
});