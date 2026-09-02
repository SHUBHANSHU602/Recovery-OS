-- Optional inspection helpers after 001_track3_hardening.sql.
-- These queries do not mutate data.

SELECT id, event_id, razorpay_api_call, idempotency_key, status
FROM actions
ORDER BY id DESC
LIMIT 20;

SELECT event_id, recovered_amount, currency, payment_link_id, payment_id, recovered_at
FROM recoveries
ORDER BY recovered_at DESC;

SELECT event_id, action_type, execute_after, status
FROM scheduled_recovery_actions
ORDER BY execute_after;
