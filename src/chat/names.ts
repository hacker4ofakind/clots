export function sessionChannelName(project: string, date: Date, timeZone: string, existing: string[]): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit" }).formatToParts(date);
  const day = parts.find((p) => p.type === "day")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `${slug}-${day}${month}`;
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

export function splitMessage(text: string, max = 2000): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const newline = rest.lastIndexOf("\n", max);
    if (newline > 0) {
      parts.push(rest.slice(0, newline));
      rest = rest.slice(newline + 1);
    } else {
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
  }
  parts.push(rest);
  return parts;
}
