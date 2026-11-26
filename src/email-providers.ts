export interface MailServers {
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
}

const PROVIDERS: { domains: string[]; servers: MailServers }[] = [
  { domains: ["googlemail.com"], servers: { imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 } } },
  { domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.de", "hotmail.de", "hotmail.co.uk", "live.co.uk"], servers: { imap: { host: "outlook.office365.com", port: 993 }, smtp: { host: "smtp-mail.outlook.com", port: 587 } } },
  { domains: ["yahoo.com", "yahoo.co.uk", "yahoo.de", "ymail.com", "rocketmail.com"], servers: { imap: { host: "imap.mail.yahoo.com", port: 993 }, smtp: { host: "smtp.mail.yahoo.com", port: 465 } } },
  { domains: ["icloud.com", "me.com", "mac.com"], servers: { imap: { host: "imap.mail.me.com", port: 993 }, smtp: { host: "smtp.mail.me.com", port: 587 } } },
  { domains: ["fastmail.com", "fastmail.fm"], servers: { imap: { host: "imap.fastmail.com", port: 993 }, smtp: { host: "smtp.fastmail.com", port: 465 } } },
  { domains: ["gmx.net", "gmx.de", "gmx.ch", "gmx.at", "gmx.com"], servers: { imap: { host: "imap.gmx.net", port: 993 }, smtp: { host: "mail.gmx.net", port: 465 } } },
  { domains: ["zoho.com", "zohomail.com"], servers: { imap: { host: "imap.zoho.com", port: 993 }, smtp: { host: "smtp.zoho.com", port: 465 } } },
  { domains: ["aol.com"], servers: { imap: { host: "imap.aol.com", port: 993 }, smtp: { host: "smtp.aol.com", port: 465 } } },
  { domains: ["bluewin.ch"], servers: { imap: { host: "imaps.bluewin.ch", port: 993 }, smtp: { host: "smtpauths.bluewin.ch", port: 465 } } },
];

const domainOf = (address: string): string => address.split("@")[1]?.toLowerCase() ?? "";

/**
 * The mail servers of a well-known provider, from the domain of the address, or undefined when the domain is not one the daemon knows
 * (a company's own domain): the user then gives the servers. Gmail's are the loader's own defaults, so they are not listed here.
 */
export function serversFor(address: string): MailServers | undefined {
  const domain = domainOf(address);
  return PROVIDERS.find((p) => p.domains.includes(domain))?.servers;
}

/** Whether the loader fills in the servers of this address itself. */
export const isGmail = (address: string): boolean => address.toLowerCase().endsWith("@gmail.com");

/** The text for an address whose servers are not known: what to give. */
export const needServers = (address: string): string => `No mail servers are known for ${domainOf(address) || address}. Give the IMAP and SMTP server of the account (a host and a port for each, such as imap.example.com 993 and smtp.example.com 465).`;
