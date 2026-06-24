-- BF-03: enforce append-only audit_events at the database boundary.

CREATE OR REPLACE FUNCTION bonfire_block_audit_events_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_block_update ON audit_events;
CREATE TRIGGER audit_events_block_update
BEFORE UPDATE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION bonfire_block_audit_events_mutation();

DROP TRIGGER IF EXISTS audit_events_block_delete ON audit_events;
CREATE TRIGGER audit_events_block_delete
BEFORE DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION bonfire_block_audit_events_mutation();
