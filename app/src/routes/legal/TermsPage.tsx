import { LegalLayout } from './LegalLayout';

export function TermsPage() {
  return (
    <LegalLayout title="Terms of use">
      <section>
        <h2 className="text-base font-semibold text-[#EDEDED]">Experimental software</h2>
        <p>
          Polygraph is an open-source project. Use it to inspect scraper output, but validate
          important decisions independently. A release verdict is evidence from the checks that
          ran, not a guarantee that data is complete, lawful, or fit for every purpose.
        </p>
      </section>
      <section>
        <h2 className="text-base font-semibold text-[#EDEDED]">Your accounts and data</h2>
        <p>
          You are responsible for the data sources, Bright Data account, credentials, and
          deployment you connect to a self-hosted server. Do not use the public sandbox to infer
          that a hosted tenant service is available; it is a local fixture demonstration.
        </p>
      </section>
      <section>
        <h2 className="text-base font-semibold text-[#EDEDED]">No automatic paid repair</h2>
        <p>
          The self-hosted server does not automatically repair collectors. Suggested repair
          commands require operator review, because third-party runs and repairs may consume
          credits or change a collector.
        </p>
      </section>
      <section>
        <h2 className="text-base font-semibold text-[#EDEDED]">License</h2>
        <p>
          The source code is available under the repository&apos;s MIT license. Those license terms
          govern use, copying, modification, and distribution of the code.
        </p>
      </section>
    </LegalLayout>
  );
}
