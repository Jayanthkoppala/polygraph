#!/usr/bin/env node
/**
 * CLI entry point. Every command lives in its own `src/cli/` module and
 * registers itself here, so adding one never touches this file's logic —
 * only its list.
 */
import { Command } from 'commander';
import { register as run } from './cli/run.js';
import { register as watch } from './cli/watch.js';
import { register as status } from './cli/status.js';
import { register as mcp } from './cli/mcp.js';
import { register as log } from './cli/log.js';
import { register as ack } from './cli/ack.js';
import { register as chaos } from './cli/chaos.js';
import { register as demo } from './cli/demo.js';
import { register as ledger } from './cli/ledger.js';
import { register as serve } from './cli/serve.js';
import { register as demo_mission } from './cli/demo-mission.js';
import { register as migrate } from './cli/migrate.js';
import { register as admin } from './cli/admin.js';

const program = new Command()
  .name('polygraph')
  .description('Verification layer for Bright Data scraper fleets')
  .version('0.1.0');

  run(program);
  watch(program);
  status(program);
  mcp(program);
  log(program);
  ack(program);
  chaos(program);
  demo(program);
  ledger(program);
  serve(program);
  demo_mission(program);
  migrate(program);
  admin(program);

program.parse(process.argv);
