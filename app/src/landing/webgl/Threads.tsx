/**
 * Threads — the landing page's one WebGL moment (ui-system.md §3.9), in the
 * fleet-scale section, below the fold, never the hero. Forty parallel lines
 * that drift — "the rail language at fleet scale": a line is a collector, a
 * straight line is a contract holding, lines that fail to track together
 * read as drift.
 *
 * NOT ReactBits' `Threads`/`ogl`: this task's file ownership is
 * `app/src/landing/**` only, and adding `ogl` would touch `app/package.json`
 * + its lockfile while other agents are actively editing `app/` — real
 * conflict risk for a single decorative component. This is a hand-rolled
 * equivalent, same cost class the spec requires: one full-screen triangle,
 * one fragment shader, no geometry, no textures, no post-processing, no
 * three.js. Flagged in the task report as a deviation from the literal
 * `ogl`/ReactBits code sample, matching its performance and visual intent.
 */
import { useEffect, useRef } from 'react';

const LINE_COUNT = 40;

const VERTEX_SRC = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SRC = `
precision mediump float;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_color;
const int LINE_COUNT = ${LINE_COUNT};

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float acc = 0.0;
  for (int i = 0; i < LINE_COUNT; i++) {
    float fi = float(i);
    float base = (fi + 0.5) / float(LINE_COUNT);
    // Slow per-line drift plus a horizontal wander — most lines track
    // together, a few diverge, same idea as the rail's own drift.
    float drift = sin(u_time * 0.12 + fi * 0.9) * 0.010;
    float wander = sin(uv.x * 6.2831 * 1.2 + fi * 0.35 + u_time * 0.05) * 0.004;
    float y = base + drift + wander;
    float d = abs(uv.y - y);
    acc += smoothstep(0.0018, 0.0, d);
  }
  acc = clamp(acc, 0.0, 1.0);
  gl_FragColor = vec4(u_color * acc, acc);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export interface ThreadsProps {
  /** Normalized RGB, e.g. [1, 1, 1] for white — matches ReactBits' own
   * `color` prop convention (not hex), per ui-system.md §3.9. */
  color?: [number, number, number];
}

export function Threads({ color = [1, 1, 1] }: ThreadsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    if (!vertexShader || !fragmentShader) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

    // One full-screen triangle — no geometry beyond three vertices.
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const positionLoc = gl.getAttribLocation(program, 'a_position');
    const resolutionLoc = gl.getUniformLocation(program, 'u_resolution');
    const timeLoc = gl.getUniformLocation(program, 'u_time');
    const colorLoc = gl.getUniformLocation(program, 'u_color');

    let raf = 0;
    const start = performance.now();

    function resize() {
      if (!canvas || !gl) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function frame(now: number) {
      if (!gl) return;
      resize();
      gl.useProgram(program);
      gl.enableVertexAttribArray(positionLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(resolutionLoc, canvas!.width, canvas!.height);
      gl.uniform1f(timeLoc, (now - start) / 1000);
      gl.uniform3f(colorLoc, color[0], color[1], color[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteBuffer(positionBuffer);
    };
    // color is a small literal tuple passed fresh each render in practice;
    // re-running the whole GL setup on every render would be wasteful and
    // isn't needed since FleetScale passes a stable constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} data-testid="threads-canvas" className="h-full w-full" aria-hidden />;
}
