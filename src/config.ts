import type { Availability, SlotRules } from "./slots";

export interface Question {
  id: string;
  label: string;
  type: "text" | "textarea" | "select";
  options?: string[];
  required?: boolean;
}

export interface EventType {
  slug: string;
  name: string;
  description: string;
  durationMin: number;
  location: string;
  questions: Question[];
}

export interface Tenant {
  slug: string;
  name: string;
  hostName: string;
  hostEmail: string;
  fromEmail: string;
  publicBaseUrl: string;
  footer: string[]; // shown verbatim under the booking page
  availability: Availability;
  rules: Omit<SlotRules, "durationMin">;
  eventTypes: EventType[];
}

const heardAbout: Question = {
  id: "heard_about",
  label: "How did you hear about Alderlux?",
  type: "select",
  options: ["Personal introduction", "A client of Alderlux", "Solicitor or accountant", "Financial adviser", "LinkedIn", "X (Twitter)", "Telegram", "Search engine", "The Insider", "Other"],
  required: true,
};

// Working hours: copied from Calendly on 06/11/2026, then restricted by Robert on 06/11/2026:
// never Saturdays; never Sundays 09:00-20:00; never weekdays 00:00-05:00 or 14:00-20:00.
// Monday widened by Robert on 06/11/2026 to 05:00-14:00 (client sessions block themselves via Outlook).
const alderluxAvailability: Availability = {
  timezone: "Europe/London",
  weekly: {
    sunday: [{ from: "20:00", to: "23:45" }],
    monday: [{ from: "05:00", to: "14:00" }, { from: "20:00", to: "23:45" }], // Robert 06/11/2026: open 05:00-14:00; Ashley and Annabelle are blocked by Outlook
    tuesday: [{ from: "06:15", to: "07:00" }, { from: "09:30", to: "13:00" }, { from: "20:00", to: "23:45" }],
    wednesday: [{ from: "06:15", to: "07:00" }, { from: "09:30", to: "13:00" }, { from: "20:00", to: "23:45" }],
    thursday: [{ from: "06:15", to: "07:00" }, { from: "12:30", to: "14:00" }, { from: "20:00", to: "23:45" }],
    friday: [{ from: "06:15", to: "07:00" }, { from: "09:30", to: "13:00" }, { from: "20:00", to: "23:45" }],
    saturday: [],
  },
  dateOverrides: {},
};

export const TENANTS: Record<string, Tenant> = {
  alderlux: {
    slug: "alderlux",
    name: "Alderlux",
    hostName: "Robert Hughes",
    hostEmail: "admin@alderlux.com",
    fromEmail: "admin@alderlux.com",
    publicBaseUrl: "https://book.alderlux.com",
    footer: [
      "Alderlux provides education and information only. We do not provide regulated financial advice, investment recommendations, legal or tax advice. Alderlux is not authorised by the Financial Conduct Authority.",
    ],
    availability: alderluxAvailability,
    rules: { stepMin: 30, minNoticeMin: 12 * 60, maxDaysAhead: 60, bufferMin: 30 }, // 30 min clear before and after every booked call (Robert, 06/11/2026)
    eventTypes: [
      {
        slug: "the-edge",
        name: "The Edge: introductory call",
        description: "A 60-minute conversation to understand where you are with Bitcoin and whether one-to-one tuition through The Edge suits you.",
        durationMin: 60,
        location: "Zoom, or in person at Adelphi Mill, Grimshaw Lane, Bollington, SK10 5JB",
        questions: [
          { id: "goal", label: "What would you most like to understand or be able to do?", type: "textarea" },
          { id: "held_for", label: "How long have you held Bitcoin?", type: "select", options: ["None yet", "Under 1 year", "1–5 years", "Over 5 years"] },
          { id: "held_how", label: "How do you hold it now?", type: "select", options: ["Exchange", "My own wallet", "Both", "Not yet"] },
          heardAbout,
        ],
      },
      {
        slug: "succession",
        name: "Succession: introductory consultation",
        description: "A confidential consultation on making Bitcoin reachable by the right people if you die or lose capacity.",
        durationMin: 45,
        location: "Zoom, or in person at Adelphi Mill, Grimshaw Lane, Bollington, SK10 5JB",
        questions: [
          { id: "for_whom", label: "Is this for yourself, a family member, or a client?", type: "select", options: ["Myself", "A family member", "A client (I am a professional adviser)"] },
          { id: "solicitor", label: "Is a solicitor involved? If so, which firm?", type: "text" },
          { id: "held_how", label: "Roughly how is the Bitcoin held?", type: "select", options: ["Exchange", "Own wallet", "Multi-sig", "Mixed", "Not sure"] },
          heardAbout,
        ],
      },
      {
        slug: "corporate",
        name: "Corporate: briefing call",
        description: "A briefing for directors considering Bitcoin in their business: treasury, payments or board education.",
        durationMin: 30,
        location: "Zoom",
        questions: [
          { id: "company", label: "Company name and your role", type: "text", required: true },
          { id: "considering", label: "What are you considering?", type: "select", options: ["Treasury", "Accepting Bitcoin", "Board or staff education", "Other"] },
          { id: "timescale", label: "Timescale", type: "select", options: ["Exploring", "Immediate", "Next 3 months", "Next 12 months"] },
          heardAbout,
        ],
      },
    ],
  },
};

export function getTenant(slug: string): Tenant | undefined {
  return TENANTS[slug];
}
