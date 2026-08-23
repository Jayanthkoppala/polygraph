import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const HOST = '127.0.0.1';
const PORT = '8080';

function listeners() {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-Fpct'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const entries = [];
    let current = {};
    for (const line of output.split('\n')) {
      if (!line) continue;
      const key = line[0];
      const value = line.slice(1);
      if (key === 'p') {
        if (current.pid) entries.push(current);
        current = { pid: value };
      } else if (key === 'c') current.command = value;
      else if (key === 't') current.name = value;
    }
    if (current.pid) entries.push(current);
    return entries;
  } catch {
    return [];
  }
}

const occupied = listeners();
if (occupied.length > 0) {
  const owner = occupied.map(({ pid, command, name }) => `PID ${pid} (${command ?? name ?? 'unknown'})`).join(', ');
  process.stderr.write(`Polygraph local runtime did not start: ${HOST}:${PORT} is already in use by ${owner}.\n`);
  process.stderr.write('Stop that process or use the existing http://127.0.0.1:8080 product server.\n');
  process.exit(1);
}

if (!existsSync('app/node_modules')) {
  process.stderr.write('app/node_modules missing — installing front-end dependencies once.\n');
  const install = spawnSync('npm', ['--prefix', 'app', 'install'], { stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const build = spawnSync('npm', ['run', 'build:all'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const serve = spawnSync('npm', ['run', 'serve', '--', '--host', HOST, '--port', PORT], {
  stdio: 'inherit',
  // CSRF compares the Origin header to this string exactly; default it to the
  // URL we tell the operator to open so signup and key-save work out of the box.
  env: { POLYGRAPH_PUBLIC_ORIGIN: `http://${HOST}:${PORT}`, ...process.env },
});
process.exit(serve.status ?? 1);
