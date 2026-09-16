export function log(scope: string, message: string, extra?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}`;
  console.log(extra ? `${line} ${JSON.stringify(extra)}` : line);
}
