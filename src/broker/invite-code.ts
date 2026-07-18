import { randomBytes } from "node:crypto";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_LENGTH = 10;

export function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  return [...bytes]
    .map((value) => INVITE_ALPHABET[value & 31])
    .join("");
}

export function normalizeInviteCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function formatInviteCode(value: string): string {
  const normalized = normalizeInviteCode(value);
  return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}
