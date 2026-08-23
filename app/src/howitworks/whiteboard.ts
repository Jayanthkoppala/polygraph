// Whiteboard markup exported from the approved design artifact (session 2026-08-23).
// Kept as raw SVG so the Excalidraw-style filters/markers stay byte-identical to the design.
export const HOW_IT_WORKS_SVG = String.raw`<svg class="hiw-svg" viewBox="0 0 1600 732" preserveAspectRatio="xMidYMin meet" aria-label="Polygraph product architecture: autonomous repair loop">
    <defs>
      <filter id="roughR" x="-2%" y="-2%" width="104%" height="104%">
        <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="3" result="n"/>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
      <filter id="blur" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="6"/></filter>
      <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
        <rect width="24" height="24" fill="rgba(1,0,255,.05)"/>
        <path d="M24 0 H0 V24" fill="none" stroke="rgba(143,146,255,.10)" stroke-width=".6"/>
      </pattern>
      <filter id="rough" x="-2%" y="-2%" width="104%" height="104%">
        <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="n"/>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="1.4" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
      <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#b7b7b1" stroke-width="1.4"/></marker>
      <marker id="ahb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#8f92ff" stroke-width="1.4"/></marker>
      <marker id="aha" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#fbbf24" stroke-width="1.4"/></marker>
      <marker id="ahm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#7d7d78" stroke-width="1.4"/></marker>
      <marker id="ahr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#f85149" stroke-width="1.4"/></marker>
      <marker id="ahg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#4ade80" stroke-width="1.4"/></marker>
    </defs>
    <g class="rough">
      <!-- ===== OUTSIDE · CUSTOMER'S TARGET SITES ===== -->
      <rect class="roughR region out" x="40" y="34" width="320" height="196" rx="12"/>
      <text class="rl out" x="54" y="52">OUTSIDE · CUSTOMER'S TARGET SITES</text>
      <rect class="box" x="70" y="84" width="260" height="44" rx="9"/>
      <text class="lbl" x="200" y="111">Target pages</text>
      <text class="note" x="200" y="146">structure changes over time</text>
      <text class="note" x="200" y="161">nobody announces it</text>

      <!-- ===== OUTSIDE · BRIGHT DATA ===== -->
      <rect class="roughR region out" x="400" y="34" width="1160" height="196" rx="12"/>
      <text class="rl out" x="414" y="52">OUTSIDE · BRIGHT DATA · THE ONLY RUN SOURCE · NO POLYGRAPH SCHEDULER</text>

      <path class="wire draw" d="M330 106 L426 106"/>
      <rect class="box" x="430" y="84" width="200" height="44" rx="9"/>
      <text class="lbl" x="530" y="111">Scraper Studio collector</text>
      <text class="note" x="530" y="146">customer's own schedule</text>

      <path class="wire draw" d="M630 106 L666 106"/>
      <rect class="box red tint-red" x="670" y="84" width="200" height="44" rx="9"/>
      <circle cx="872" cy="82" r="9" fill="#03031c" stroke="#f85149" stroke-width="1.4"/><text class="glyph" x="872" y="86" fill="#f85149">!</text>
      <text class="lbl red" x="770" y="111">Completed run</text>
      <text class="note" x="770" y="146">delivered by webhook</text>
      <text class="note red" x="770" y="161">one day: required field → null</text>

      <rect class="box amber" x="910" y="84" width="200" height="44" rx="9"/>
      <text class="lbl amber" x="1010" y="111">Self-Healing</text>
      <text class="note" x="990" y="146">proposes a repaired scraper</text>

      <path class="wire amber draw" d="M1110 106 L1146 106"/>
      <rect class="box" x="1150" y="84" width="180" height="44" rx="9"/>
      <text class="lbl" x="1240" y="111">Candidate repair</text>
      <text class="note" x="1240" y="146">same collector id</text>

      <rect class="box" x="1370" y="84" width="170" height="44" rx="9"/>
      <text class="lbl" x="1455" y="111">Publish template</text>

      <path class="wire draw" d="M1455 128 L1455 156"/>
      <rect class="box" x="1370" y="160" width="170" height="44" rx="9"/>
      <text class="lbl" x="1455" y="187">Fresh delivery</text>
      <text class="note" x="1455" y="218">one trigger · stored input</text>

      <!-- ===== INSIDE · POLYGRAPH ===== -->
      <rect class="glow" x="40" y="262" width="1520" height="458" rx="14"/>
      <rect class="roughR region pg" x="40" y="262" width="1520" height="458" rx="14"/>
      <text class="rl pg" x="54" y="282">INSIDE · POLYGRAPH · CLOSED AUTONOMOUS LOOP — NO HUMAN FROM BREAK TO VERIFIED</text>

      <!-- Ingest + baseline -->
      <rect class="roughR region sub" x="60" y="300" width="290" height="310" rx="10"/>
      <text class="rl" x="72" y="318">INGEST · BASELINE</text>
      <rect class="box" x="80" y="332" width="250" height="40" rx="8"/>
      <text class="lbl" x="205" y="357">Webhook ingest</text>
      <text class="note" x="205" y="386">every delivery · per collector</text>
      <path class="wire draw" d="M205 394 L205 416"/>
      <rect class="box" x="80" y="420" width="250" height="40" rx="8"/>
      <text class="lbl" x="205" y="445">Learn the contract</text>
      <text class="note" x="205" y="474">first healthy delivery</text>
      <text class="note" x="205" y="489">required fields · types · entity id</text>
      <path class="wire draw" d="M205 498 L205 520"/>
      <rect class="box" x="80" y="524" width="250" height="40" rx="8"/>
      <text class="lbl" x="205" y="549">Store reusable input</text>
      <text class="note" x="205" y="578">derived from the delivery · encrypted</text>
      <text class="note" x="205" y="593">never asked from the customer</text>

      <!-- Checks -->
      <rect class="roughR region sub" x="380" y="300" width="400" height="250" rx="10"/>
      <text class="rl" x="392" y="318">CHECKS · EVERY DELIVERY · DETERMINISTIC, NOT AI</text>
      <rect class="box blue" x="395" y="332" width="180" height="40" rx="8"/>
      <text class="lbl" x="485" y="357">Shape / contract</text>
      <text class="note" x="485" y="388">required fields · types</text>
      <rect class="box blue" x="585" y="332" width="180" height="40" rx="8"/>
      <text class="lbl" x="675" y="357">Identity</text>
      <text class="note" x="675" y="388">same entity</text>
      <rect class="box blue" x="395" y="404" width="180" height="40" rx="8"/>
      <text class="lbl" x="485" y="429">Access</text>
      <text class="note" x="485" y="460">no captcha / login / block</text>
      <rect class="box blue" x="585" y="404" width="180" height="40" rx="8"/>
      <text class="lbl" x="675" y="429">Coherence</text>
      <text class="note" x="675" y="460">healthy fields undamaged</text>
      <rect class="box" x="395" y="486" width="370" height="40" rx="8"/>
      <text class="lbl" x="580" y="511">Fail → quarantine · safe output keeps serving</text>

      <!-- AI bounded -->
      <rect class="roughR region sub" x="810" y="300" width="240" height="250" rx="10"/>
      <text class="rl" x="822" y="318">AI · BOUNDED · 3 TASKS</text>
      <rect class="box blue dash" x="825" y="332" width="210" height="40" rx="8"/>
      <text class="lbl" x="930" y="357">Explain the diff</text>
      <path class="wire draw" d="M930 372 L930 390"/>
      <rect class="box blue dash" x="825" y="394" width="210" height="40" rx="8"/>
      <text class="lbl" x="930" y="419">Match past incidents</text>
      <path class="wire draw" d="M930 434 L930 452"/>
      <rect class="box blue dash" x="825" y="456" width="210" height="40" rx="8"/>
      <text class="lbl" x="930" y="481">Draft repair prompt</text>
      <text class="note" x="930" y="522">never approves · publishes</text>
      <text class="note" x="930" y="537">or declares recovery</text>

      <!-- Candidate safety test -->
      <rect class="roughR region sub" x="1080" y="300" width="230" height="250" rx="10"/>
      <text class="rl" x="1092" y="318">CANDIDATE SAFETY TEST</text>
      <rect class="box" x="1095" y="332" width="200" height="40" rx="8"/>
      <text class="lbl" x="1195" y="357">Run candidate</text>
      <text class="note" x="1195" y="386">against stored input</text>
      <text class="note" x="1195" y="401">fields · entity · access · intact</text>
      <path class="wire draw" d="M1195 410 L1195 432"/>
      <rect class="box blue tint-blue" x="1095" y="436" width="200" height="40" rx="8"/>
      <text class="lbl" x="1195" y="461">Auto-approve · publish</text>
      <text class="note" x="1195" y="490">no human in the loop</text>
      <text class="note red" x="1195" y="522">fail → stays quarantined</text>
      <text class="note red" x="1195" y="537">incident stays open</text>

      <!-- Proof gate -->
      <rect class="roughR region sub" x="1340" y="300" width="200" height="150" rx="10"/>
      <text class="rl" x="1352" y="318">PROOF GATE</text>
      <rect class="box green tint-green" x="1355" y="332" width="170" height="40" rx="8"/>
      <circle cx="1527" cy="330" r="9" fill="#03031c" stroke="#4ade80" stroke-width="1.4"/><text class="glyph" x="1527" y="334" fill="#4ade80">✓</text>
      <text class="lbl green" x="1440" y="357">Verified</text>
      <text class="note" x="1440" y="386">fresh production only</text>
      <text class="note" x="1440" y="401">candidate ≠ recovery</text>
      <rect class="box" x="1355" y="410" width="170" height="32" rx="8"/>
      <text class="lbl" x="1440" y="431" style="font-size:13.5px">Safe output advances</text>

      <!-- Memory -->
      <rect class="roughR region sub" x="1080" y="570" width="460" height="110" rx="10"/>
      <text class="rl" x="1092" y="588">MEMORY</text>
      <rect class="box" x="1095" y="600" width="130" height="36" rx="8"/>
      <text class="lbl" x="1160" y="623" style="font-size:13.5px">Ledger</text>
      <text class="note" x="1160" y="660" style="font-size:10px">deliveries · incidents</text>
      <rect class="box" x="1240" y="600" width="130" height="36" rx="8"/>
      <text class="lbl" x="1305" y="623" style="font-size:13.5px">Repair receipt</text>
      <text class="note" x="1305" y="660" style="font-size:10px">ids · hashes behind it</text>
      <rect class="box" x="1385" y="600" width="140" height="36" rx="8"/>
      <text class="lbl" x="1455" y="623" style="font-size:13.5px">Corpus N → N+1</text>
      <text class="note" x="1455" y="660" style="font-size:10px">break → permanent test</text>

      <!-- Control -->
      <rect class="roughR region sub" x="380" y="570" width="400" height="110" rx="10"/>
      <text class="rl" x="392" y="588">CONTROL</text>
      <rect class="box" x="395" y="600" width="180" height="36" rx="8"/>
      <text class="lbl" x="485" y="623" style="font-size:13.5px">Incident controller</text>
      <text class="note" x="485" y="660" style="font-size:10px">replays stored input</text>
      <rect class="box" x="585" y="600" width="180" height="36" rx="8"/>
      <text class="lbl" x="675" y="623" style="font-size:13.5px">SSE event stream</text>
      <text class="note" x="675" y="660" style="font-size:10px">no fake progress</text>

      <!-- Telegram (coming soon) -->
      <rect class="box ghost" x="810" y="600" width="240" height="36" rx="8"/>
      <text class="lbl ghost" x="930" y="623">Telegram updates · coming soon</text>
      <text class="muted" x="930" y="660" style="font-size:10px">incident · escalation · repair receipts</text>

      <!-- margin notes -->
      <text class="margin" x="90" y="196" transform="rotate(-2 90 196)">nobody announces a markup change</text>
      <text class="margin" x="110" y="646" transform="rotate(-1.5 110 646)">never asked for anything</text>
      <text class="margin" x="1428" y="482" style="text-anchor:end" transform="rotate(-2 1428 482)">green = real run</text>
      <text class="margin" x="760" y="284" transform="rotate(-1.5 760 284)">AI never holds the pen</text>

      <!-- ===== wires ===== -->
      <!-- completed run → webhook ingest -->
      <path class="wire draw" d="M770 128 L770 246 L205 246 L205 328" style="stroke:#f85149;marker-end:url(#ahr)"/>
      <text class="note red" x="487" y="240">every delivery in · including the broken one</text>
      <!-- ingest → checks -->
      <path class="wire draw" d="M330 352 L391 352"/>
      <!-- checks → AI -->
      <path class="wire draw" d="M780 352 L821 352"/>
      <!-- AI prompt → self-healing -->
      <path class="wire draw" d="M1035 476 L1060 476 L1060 170 L1090 170 L1090 132" style="stroke:#8f92ff;marker-end:url(#ahb)"/>
      <text class="tag" x="1050" y="300" transform="rotate(-90 1050 300)">prompt out</text>
      <!-- candidate → safety test -->
      <path class="wire draw" d="M1240 128 L1240 246 L1195 246 L1195 328"/>
      <text class="note" x="1250" y="240" style="text-anchor:start">candidate in</text>
      <!-- auto-approve → publish -->
      <path class="wire amber draw" d="M1295 456 L1320 456 L1320 246 L1352 246 L1352 106 L1366 106"/>
      <text class="note" x="1338" y="232" style="fill:#fbbf24;text-anchor:start" transform="rotate(-90 1338 232)">publish + trigger</text>
      <!-- fresh delivery → proof gate -->
      <path class="wire draw" d="M1455 204 L1455 328" style="stroke:#4ade80;marker-end:url(#ahg)"/>
      <text class="note" x="1464" y="250" style="fill:#4ade80;text-anchor:start">proof in</text>
      <!-- proof → memory -->
      <path class="wire draw" d="M1440 442 L1440 560 L1305 560 L1305 596"/>
      <!-- memory → checks loop -->
      <path class="wire loop" d="M1095 618 L1068 618 L1068 694 L365 694 L365 429 L391 429"/>
      <text class="tag" x="640" y="712" style="font-size:10.5px">memory feeds the next diagnosis · the corpus grows by one confirmed break per repair</text>
      <!-- outbound → Telegram (only what escapes the loop) -->
      <path class="wire tg" d="M700 526 L700 560 L795 560 L795 618 L804 618"/>
      <text class="tgtag" x="708" y="541">break detected</text>
      <path class="wire tg heavy" d="M1195 545 L1195 552 L1030 552 L1030 598"/>
      <text class="tgtag" x="1022" y="584" style="text-anchor:end">needs you · incident open</text>
      <circle cx="1305" cy="560" r="3" fill="#b7b7b1"/>
      <path class="wire tg" d="M1302 560 L1058 560 L1058 612 L1054 612"/>
      <text class="tgtag" x="1235" y="587" style="text-anchor:middle">repaired · receipt</text>
      <!-- travelling packet -->
      <circle class="pk" r="4" fill="#f85149">
        <animateMotion dur="26s" repeatCount="indefinite" begin="2s" calcMode="linear"
          path="M770 128 L770 246 L205 246 L205 352 L391 352 L780 352 L825 352 L930 352 L930 476 L1035 476 L1060 476 L1060 170 L1090 170 L1090 132 L1010 106 L1146 106 L1240 106 L1240 246 L1195 246 L1195 456 L1295 456 L1320 456 L1320 246 L1352 246 L1352 106 L1366 106 L1455 106 L1455 328 L1440 352 L1440 560 L1305 560 L1305 618 L1095 618 L1068 618 L1068 694 L365 694 L365 429 L391 429"/>
        <animate attributeName="fill" dur="26s" repeatCount="indefinite" begin="2s"
          values="#f85149;#f85149;#b7b7b1;#b7b7b1;#8f92ff;#8f92ff;#fbbf24;#fbbf24;#b7b7b1;#4ade80;#4ade80;#8f92ff;#8f92ff"
          keyTimes="0;0.08;0.09;0.22;0.23;0.33;0.34;0.5;0.62;0.66;0.76;0.8;1"/>
      </circle>
    </g>
  </svg>`;
