import { LegalLayout } from './LegalLayout';

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy">
      <section>
        <h2 className="text-base font-semibold text-[#EDEDED]">The public sandbox</h2>
        <p>
          The public site is a static browser sandbox. Its fixture data, verdicts, and ledger
          chain run in your browser. It does not ask for, transmit, or retain a Bright Data key.
        </p>
      </section>
      <section>
        <h2 className="text-base font-semibold text-[#EDEDED]">Self-hosted server</h2>
        <p>
          If you run the Polygraph server yourself, it stores the tenant, collector, scheduling,
          ledger, and last verified output snapshot needed to operate that server. One current
          snapshot of up to 1,000,000 UTF-8 bytes is retained in plaintext per collector until a
          newer release replaces it or the tenant is deleted. Bright Data keys are encrypted
          before they are stored. The decryption key belongs in your server environment, not in
          the database, and the API does not return a stored key.
        </p>
      </section>
      <section>
        <h2 className="text-base font-semibold text-[#EDEDED]">Your control</h2>
        <p>
          You choose where a self-hosted server runs and which collectors it can access. Review
          your own deployment, retention, backups, and applicable privacy obligations before
          using it with production data. If you configure the local MCP server, coding agents
          with access to that MCP connection can read the retained snapshot rows; grant that
          connection only to agents you trust with the underlying data.
        </p>
      </section>
    </LegalLayout>
  );
}
