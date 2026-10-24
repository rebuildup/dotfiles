/** Pi prints its version on stderr; Claude/OpenCode normally use stdout. */
export function parseHarnessVersion(
  stdout: string,
  stderr: string,
): string | null {
  const printed = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (printed) return printed;
  return (
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) =>
        /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?(?: \([^\r\n]+\))?$/.test(line),
      ) ?? null
  );
}
