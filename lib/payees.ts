export const normalizePayeeName = (name: string) => {
  return name
    .trim()
    .replace(/\s+/g, " ")
    // Normalize various quote characters to straight apostrophe
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'");
};
