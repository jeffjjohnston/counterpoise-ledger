-- Books have their own id rather than book_id. Keep the same hint-only
-- payload and commit semantics as the book-scoped table triggers.
CREATE FUNCTION notify_counterpoise_book_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('counterpoise_changes', json_build_object('bookId', OLD.id, 'table', TG_TABLE_NAME)::text);
  ELSE
    IF TG_OP = 'UPDATE' THEN
      IF OLD.id IS DISTINCT FROM NEW.id THEN
        PERFORM pg_notify('counterpoise_changes', json_build_object('bookId', OLD.id, 'table', TG_TABLE_NAME)::text);
      END IF;
    END IF;
    PERFORM pg_notify('counterpoise_changes', json_build_object('bookId', NEW.id, 'table', TG_TABLE_NAME)::text);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON books
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_book_change();
