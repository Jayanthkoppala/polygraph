// `/how-it-works`: the product architecture as one whiteboard that fits a single viewport
// under the global chrome. Markup is raw SVG from the design artifact (see whiteboard.ts).
import { HOW_IT_WORKS_SVG } from './whiteboard';
import './HowItWorks.css';

export function HowItWorksPage() {
  return (
    <main className="hiw" aria-label="How Polygraph works">
      <header>
        <div>
          <div className="eyebrow">How it works</div>
          <h1>
            Connect a collector. Polygraph keeps it truthful — <em>autonomously</em>.
          </h1>
        </div>
        <div className="legend" aria-label="Legend">
          <span><i /> Polygraph</span>
          <span><i className="ai" /> AI · bounded</span>
          <span><i className="bd" /> Bright Data</span>
        </div>
      </header>
      {/* Static, author-controlled markup: no user content reaches this string. */}
      <div className="board" dangerouslySetInnerHTML={{ __html: HOW_IT_WORKS_SVG }} />
    </main>
  );
}
