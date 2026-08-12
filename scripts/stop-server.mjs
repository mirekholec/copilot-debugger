import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const pidFilePath = process.env.COPILOT_DEBUGGER_PID_FILE ?? path.resolve(process.cwd(), '.copilot-debugger.pid');
const port = Number.parseInt(process.env.PORT ?? '4317', 10);

let pid;
try {
  pid = Number.parseInt((await fs.readFile(pidFilePath, 'utf8')).trim(), 10);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) {
  await fs.rm(pidFilePath, { force: true });
  throw new Error(`Invalid server PID in ${pidFilePath}`);
}

const candidates = pid === undefined ? findListeningPids(port) : [pid];
const serverPid = candidates.find(isProjectServer);
if (serverPid === undefined) {
  await fs.rm(pidFilePath, { force: true });
  console.log('Copilot Debugger server is not running.');
  process.exit(0);
}

try {
  process.kill(serverPid, 0);
  process.kill(serverPid, 'SIGTERM');
  await fs.rm(pidFilePath, { force: true });
  console.log(`Stopping Copilot Debugger server (PID ${serverPid}).`);
} catch (error) {
  if (error?.code === 'ESRCH') {
    await fs.rm(pidFilePath, { force: true });
    console.log('Copilot Debugger server is not running.');
    process.exit(0);
  }
  throw error;
}

function findListeningPids(listeningPort) {
  if (!Number.isInteger(listeningPort) || listeningPort < 1 || listeningPort > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }

  try {
    const output = execFileSync('lsof', [`-tiTCP:${listeningPort}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.status === 1) return [];
    throw error;
  }
}

function isProjectServer(candidatePid) {
  try {
    const cwdOutput = execFileSync('lsof', ['-a', '-p', String(candidatePid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const cwd = cwdOutput.split('\n').find((line) => line.startsWith('n'))?.slice(1);
    if (!cwd || path.resolve(cwd) !== path.resolve(process.cwd())) return false;

    const command = execFileSync('ps', ['-p', String(candidatePid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return /(?:^|\s)(?:dist\/)?server\/index(?:\.js)?(?:\s|$)/.test(command);
  } catch {
    return false;
  }
}
