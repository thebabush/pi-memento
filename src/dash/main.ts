import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { startDashboard } from './server.js';
import { createSessionStore } from './sessions.js';

const DEFAULT_PORT = 4777;

function parsePort(args: readonly string[]): number {
  const index = args.indexOf('--port');
  const raw = index >= 0 ? args[index + 1] : process.env.PIM_DASHBOARD_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`Invalid port: ${raw}`);
  return port;
}

const port = parsePort(process.argv.slice(2));
const sessionsDir = join(getAgentDir(), 'sessions');
const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dash-ui');

startDashboard({ store: createSessionStore(sessionsDir), uiDir, port }).then(
  () => process.stdout.write(`pim dashboard: http://127.0.0.1:${port}  (sessions in ${sessionsDir})\n`),
  (error: unknown) => {
    process.stderr.write(`pim dashboard: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
