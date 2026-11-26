"""Makes every tracked file's line endings match the index, and every new text file LF.
CRLF is kept only for files git stores as CRLF (src/commands.ts, tests/commands.test.ts)."""
import subprocess, sys, os

out = subprocess.run(["git", "ls-files", "--eol", "-co", "--exclude-standard"], capture_output=True, text=True, encoding="utf8").stdout
fixed = 0
for line in out.splitlines():
    meta, _, path = line.partition("\t")
    parts = meta.split()
    index = parts[0] if parts else ""
    work = parts[1] if len(parts) > 1 else ""
    if not os.path.isfile(path) or work in ("w/-text", "w/none") or "binary" in meta or index == "i/mixed":
        continue
    want_crlf = index == "i/crlf"
    data = open(path, "rb").read()
    if b"\0" in data:
        continue
    text = data.replace(b"\r\n", b"\n")
    if want_crlf:
        text = text.replace(b"\n", b"\r\n")
    if text != data:
        open(path, "wb").write(text)
        fixed += 1
        print("fixed", path)
print("fixed", fixed, "files")
