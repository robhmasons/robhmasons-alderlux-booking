// Minimal RFC 5545 calendar file for one booking.

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** Fold lines longer than 75 octets, as the standard requires. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (new TextEncoder().encode(rest).length > 75) {
    let cut = 75;
    while (new TextEncoder().encode(rest.slice(0, cut)).length > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildIcs(b: {
  uid: string;
  start: number;
  end: number;
  summary: string;
  description: string;
  location: string;
  organizerEmail: string;
  status?: "CONFIRMED" | "CANCELLED";
  now?: number;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Alderlux//Booking//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${b.status === "CANCELLED" ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${b.uid}`,
    `DTSTAMP:${stamp(b.now ?? Date.now())}`,
    `DTSTART:${stamp(b.start)}`,
    `DTEND:${stamp(b.end)}`,
    `SUMMARY:${escapeText(b.summary)}`,
    `DESCRIPTION:${escapeText(b.description)}`,
    `LOCATION:${escapeText(b.location)}`,
    `ORGANIZER:mailto:${b.organizerEmail}`,
    `STATUS:${b.status ?? "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
