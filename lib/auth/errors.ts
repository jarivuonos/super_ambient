// Tunnistautumisen virhekoodit ja kiinteät viestit (turvallisia näyttää selaimessa). Ei riippuvuuksia.

export type AuthErrorCode =
  | "not-configured"
  | "denied"
  | "state-mismatch"
  | "discovery-failed"
  | "token-failed"
  | "bad-response";

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  "not-configured": "Asiakastunnusta ei ole asetettu palvelimen asetuksissa.",
  denied: "Kirjautuminen keskeytettiin tai evättiin.",
  "state-mismatch": "Kirjautumisen tila ei täsmännyt; aloita kirjautuminen uudelleen.",
  "discovery-failed": "Palvelimen kirjautumisosoitteita ei saatu.",
  "token-failed": "Tunnistautumispalvelin ei hyväksynyt kirjautumista.",
  "bad-response": "Tunnistautumispalvelimen vastaus oli odottamaton.",
};

export class SmartAuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly status?: number,
  ) {
    super(AUTH_ERROR_MESSAGES[code]);
    this.name = "SmartAuthError";
  }
}

export function isAuthErrorCode(v: unknown): v is AuthErrorCode {
  return typeof v === "string" && v in AUTH_ERROR_MESSAGES;
}
