import type { Command } from 'commander';
import { stub } from './shared.js';

/** Registers `polygraph status` on the root program. */
export function register(program: Command): void {
  program
    .command('status')
    .description('Show current health status for the fleet')
    .action(stub('status'));
}
