/** Custom window events used to coordinate refreshes across the client. */

/** Dispatched by PriceEntryPill after prices are saved. */
export const PRICES_SAVED_EVENT = "counterpoise:security-prices-saved";

/** Dispatched by ReconciliationModal when the sync queue changes. */
export const SYNC_QUEUE_CHANGED_EVENT = "counterpoise:sync-queue-changed";

/** Stops this tab's book stream after a successful logout. */
export const BOOK_SESSION_ENDED_EVENT = "counterpoise:session-ended";
