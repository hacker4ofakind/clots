import { api } from "@/lib/api-client";
import { readableError } from "@/lib/readable-error";

/** The daemon refuses larger pictures; saying so here saves the upload. */
const MAX_BYTES = 2 * 1024 * 1024;

/** What a file that is not a picture at all gets, from the file dialog (which already offers only pictures). */
export const UNREADABLE = "That file couldn't be read as an image. Try another one.";
/** What a pasted thing that is not a picture gets: the only place the accepted types need saying. */
export const NOT_A_PICTURE = "Paste an image, or upload an SVG, PNG, JPG, WebP or ICO.";
const TOO_LARGE = "That image is too large. An icon can be up to 2 MB.";

/** A problem to show as it is. */
export class IconUploadProblem extends Error {}

const read = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/**
 * Sends a picked or pasted file to the daemon as an icon and returns its id. The browser's idea of the file's type is not
 * used (an SVG and an ICO often come with none): the daemon reads the file's own bytes, converts SVG and ICO to a PNG and
 * keeps nothing else. Throws an IconUploadProblem whose message is fit to show.
 */
export async function uploadIcon(file: File, from: "dialog" | "paste"): Promise<string> {
  if (from === "paste" && !file.type.startsWith("image/")) throw new IconUploadProblem(NOT_A_PICTURE);
  if (file.size > MAX_BYTES) throw new IconUploadProblem(TOO_LARGE);
  if (file.size === 0) throw new IconUploadProblem(UNREADABLE);
  let dataUrl: string;
  try {
    dataUrl = await read(file);
  } catch {
    throw new IconUploadProblem(UNREADABLE);
  }
  try {
    return (await api<{ iconId: string }>("/clots/icons", { method: "POST", body: { dataUrl } })).iconId;
  } catch (e) {
    throw new IconUploadProblem(readableError(e, "The icon could not be uploaded. Try again."));
  }
}
