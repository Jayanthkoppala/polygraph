import { MissionExperience } from './MissionExperience';

export function LandingPage({ mode = 'landing' }: { mode?: 'landing' | 'proof' }) {
  return (
    <div>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm
                   focus:bg-[#EDEDED] focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#000000]"
      >
        Skip to content
      </a>
      <div id="main">
        <MissionExperience mode={mode} />
      </div>
    </div>
  );
}
