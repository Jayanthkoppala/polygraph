import type { Command } from 'commander';
import { CHAOS_MODES, DEFAULT_FIXTURE_STATE_PATH, isChaosMode, writeChaosMode } from '../fixture/state.js';

/** Registers `polygraph chaos` on the root program. */
export function register(program: Command): void {
  program
    .command('chaos <mode>')
    .description(`Flip the local fixture catalog into a chaos mode (${CHAOS_MODES.join('|')})`)
    .option('--state-file <path>', 'path to the fixture chaos state switch file', DEFAULT_FIXTURE_STATE_PATH)
    .action((mode: string, opts: { stateFile: string }) => {
      if (!isChaosMode(mode)) {
        process.stderr.write(`polygraph chaos: unknown mode "${mode}" — must be one of ${CHAOS_MODES.join(', ')}\n`);
        process.exitCode = 1;
        return;
      }
      writeChaosMode(opts.stateFile, mode);
      process.stdout.write(`polygraph chaos: fixture mode set to "${mode}" (${opts.stateFile})\n`);
    });
}
