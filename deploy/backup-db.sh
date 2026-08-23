#!/usr/bin/env bash
# Back up the running Polygraph VM's SQLite ledger to a timestamped dir on
# the VM itself (no sqlite3 CLI needed — uses better-sqlite3's own VACUUM
# INTO via a one-line node -e inside the running container, which produces a
# consistent snapshot even while the process keeps writing).
#
# Usage: bash deploy/backup-db.sh <vm>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
vm="${1:?usage: backup-db.sh <vm>}"
ts="$(date -u +%Y%m%dT%H%M%SZ)"

echo "==> backing up polygraph.sqlite on ${vm} to ~/backups/${ts}/"

bash "$here/remote.sh" "$vm" exec "
  set -euo pipefail
  mkdir -p ~/backups/${ts}
  db_path=\$(docker exec polygraph node -e \"console.log(process.env.POLYGRAPH_DB || '/data/polygraph.sqlite')\")
  docker exec polygraph node -e \"
    const Database = require('better-sqlite3');
    const db = new Database('\${db_path}', { readonly: true });
    db.exec(\\\"VACUUM INTO '/data/backup-${ts}.sqlite'\\\");
    db.close();
  \"
  docker cp \"polygraph:/data/backup-${ts}.sqlite\" \"\$HOME/backups/${ts}/polygraph.sqlite\"
  docker exec polygraph rm -f \"/data/backup-${ts}.sqlite\"
  ls -la \"\$HOME/backups/${ts}/\"
"

echo "==> done: ~/backups/${ts}/polygraph.sqlite on ${vm}"
echo "==> pull it locally with: bash deploy/remote.sh ${vm} get ~/backups/${ts}/polygraph.sqlite ./backup-${ts}.sqlite"
