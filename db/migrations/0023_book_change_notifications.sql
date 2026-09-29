-- Invalidation hints only. PostgreSQL delivers at commit and folds identical
-- payloads within a transaction. Never include row data, IDs or timestamps.
CREATE FUNCTION notify_counterpoise_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('counterpoise_changes', json_build_object('bookId', OLD.book_id, 'table', TG_TABLE_NAME)::text);
  ELSE
    IF TG_OP = 'UPDATE' THEN
      IF OLD.book_id IS DISTINCT FROM NEW.book_id THEN
        PERFORM pg_notify('counterpoise_changes', json_build_object('bookId', OLD.book_id, 'table', TG_TABLE_NAME)::text);
      END IF;
    END IF;
    PERFORM pg_notify('counterpoise_changes', json_build_object('bookId', NEW.book_id, 'table', TG_TABLE_NAME)::text);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON transactions
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON transaction_splits
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON investment_splits
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON investment_lots
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON accounts
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON payees
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON securities
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON security_prices
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON recurring_rules
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON recurring_template_splits
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON plaid_accounts
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON plaid_transaction_reconciliation
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
