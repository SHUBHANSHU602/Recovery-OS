import express from "express";

const app = express();
app.use(express.json());

app.post("/webhooks/razorpay", (req, res) => {
  console.log("=== Webhook received ===");
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).send("OK");
});

app.listen(3000, () => {
  console.log("Server listening on http://localhost:3000");
});