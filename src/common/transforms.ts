// src/common/transforms.ts

export const trimOrNull = ({ value }: { value: unknown }) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  const t = value.trim();
  return t.length ? t : null;
};

export const trimOnly = ({ value }: { value: unknown }) => {
  if (typeof value !== "string") return value;
  return value.trim();
};

export const normalizeEmailOrNull = ({ value }: { value: unknown }) => {
  const v = trimOrNull({ value });
  if (v === null) return null;
  if (typeof v !== "string") return v;
  return v.toLowerCase();
};

// Esperado: +1XXXXXXXXXX (E.164 US). No transforma, solo normaliza whitespace.
export const normalizeUSPhoneE164OrNull = ({ value }: { value: unknown }) => {
  const v = trimOrNull({ value });
  if (v === null) return null;
  if (typeof v !== "string") return v;
  return v;
};

export const normalizeZip5OrNull = ({ value }: { value: unknown }) => {
  const v = trimOrNull({ value });
  if (v === null) return null;
  if (typeof v !== "string") return v;

  const digits = v.replace(/\D/g, "");
  if (!digits.length) return null;

  return digits.slice(0, 5);
};
 
export const normalizeStateCodeOrNull = ({ value }: { value: unknown }) => {
  const v = trimOrNull({ value });
  if (v === null) return null;
  if (typeof v !== "string") return v;
  return v.toUpperCase();
};
