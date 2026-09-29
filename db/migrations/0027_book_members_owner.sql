-- Every existing book gets its creator as owner.
INSERT INTO book_members (book_id, user_id, role, created_at)
SELECT id, user_id, 'owner', created_at FROM books
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Every new book gets its creator as owner, whatever path inserts it.
CREATE FUNCTION add_book_creator_as_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO book_members (book_id, user_id, role, created_at)
  VALUES (NEW.id, NEW.user_id, 'owner', NEW.created_at)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER book_creator_owner AFTER INSERT ON books
FOR EACH ROW EXECUTE FUNCTION add_book_creator_as_owner();
--> statement-breakpoint
-- Invalidation hint for open pages, same as the other book-scoped tables.
CREATE TRIGGER counterpoise_changes AFTER INSERT OR UPDATE OR DELETE ON book_members
FOR EACH ROW EXECUTE FUNCTION notify_counterpoise_change();
