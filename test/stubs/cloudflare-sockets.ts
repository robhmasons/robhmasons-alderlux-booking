// Test stand-in for the Workers-only "cloudflare:sockets" module (SMTP is not exercised in these tests).
export function connect(): never {
  throw new Error("sockets are not available in tests");
}
