/**
 * A Clot's name is shown exactly as it was typed ("Truecast", "Encryptify"). Everything the machine keys on a name
 * (container, volumes, the rule file) uses its slug, the name in lower case, and two names with the same slug are the
 * same Clot. A Clot made before names could have capitals has a lowercase name, so its slug is its name and it keeps
 * its container and volumes.
 */
export const CLOT_NAME = /^[A-Za-z][A-Za-z0-9-]{0,30}$/;

export const CLOT_NAME_RULE = "A name is letters, digits and hyphens, starting with a letter, up to 31 characters.";

/** The lowercase form of a name that Docker names, volumes and paths use, and uniqueness is checked on. */
export function slugOf(name: string): string {
  return name.toLowerCase();
}

/** Whether two names are the same Clot. */
export function sameClot(a: string, b: string): boolean {
  return slugOf(a) === slugOf(b);
}

/** What a Clot is called to the user: its name as typed, and "Home" for the home Clot (whose name is the lowercase `home`). */
export function labelOf(name: string): string {
  return name === "home" ? "Home" : name;
}

/** Whose rules a rule file holds, to the user: "every Clot" for the global file, else the Clot's name. */
export function rulesOf(file: string): string {
  return file === "global" ? "every Clot" : labelOf(file);
}
