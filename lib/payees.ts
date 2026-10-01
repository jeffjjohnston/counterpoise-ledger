/**
 * Normalizes a payee name. It trims the name, changes each run of white space
 * to one space, and changes curly and other quote characters to a straight
 * apostrophe. It does not change the case: "IKEA" and "Ikea" are different
 * payees. `normalize_payee_name()` in rust-api/core/src/names.rs applies the
 * same rules.
 */
export const normalizePayeeName = (name: string) => {
  return name
    .trim()
    .replace(/\s+/g, " ")
    // Normalize various quote characters to straight apostrophe
    .replace(/[‘’‚‛′`´]/g, "'");
};
