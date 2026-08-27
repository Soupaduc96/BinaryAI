-- BinaryAI :: the simulated-payout ledger entry type
--
-- This migration does ONE thing, and the reason is a PostgreSQL rule rather
-- than a design choice: a new enum value cannot be USED in the same
-- transaction that adds it ("unsafe use of new value"). The migration runner
-- wraps each file in its own transaction, so the CHECK constraint that permits
-- this value has to live in the next migration (0007).
--
-- Splitting it is the standard workaround. Merging the two would fail on every
-- database, not just this one.

ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'simulated_payout';
