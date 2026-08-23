/**
 * Advisory-only Gemini seam. It never makes a recovery decision: callers must
 * first pass Polygraph's deterministic identity, contract, and regression
 * gates. The narrow JSON schema makes the model useful for explanation and a
 * clearer Bright Data self-healing prompt, without giving it authority to
 * promote a result.
 */
import { GoogleAuth } from 'google-auth-library';

export type FailureFamily = 'selector_anchor_moved' | 'missing_required_field' | 'unknown';

export interface RecoveryAdvice {
  explanation: string;
  failure_family: FailureFamily;
  heal_prompt: string;
}

export interface FailureAdvisor {
  advise(input: { baseline_version: string; changed_version: string; changed_fields: string[]; deterministic_prompt: string }): Promise<RecoveryAdvice>;
}

export interface GeminiAdvisorOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export interface VertexGeminiAdvisorOptions {
  project: string;
  location?: string;
  model?: string;
  auth?: Pick<GoogleAuth, 'request'>;
}

const responseSchema = {
  type: 'OBJECT',
  properties: {
    explanation: { type: 'STRING' },
    failure_family: { type: 'STRING', enum: ['selector_anchor_moved', 'missing_required_field', 'unknown'] },
    heal_prompt: { type: 'STRING' },
  },
  required: ['explanation', 'failure_family', 'heal_prompt'],
} as const;

function asAdvice(value: unknown): RecoveryAdvice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gemini advice was not a JSON object');
  const item = value as Record<string, unknown>;
  const explanation = typeof item.explanation === 'string' ? item.explanation.trim() : '';
  const failureFamily = item.failure_family;
  const healPrompt = typeof item.heal_prompt === 'string' ? item.heal_prompt.trim() : '';
  if (!explanation || !healPrompt || (failureFamily !== 'selector_anchor_moved' && failureFamily !== 'missing_required_field' && failureFamily !== 'unknown')) {
    throw new Error('Gemini advice did not match the recovery schema');
  }
  return { explanation, failure_family: failureFamily, heal_prompt: healPrompt };
}

function requestBody(input: { baseline_version: string; changed_version: string; changed_fields: string[]; deterministic_prompt: string }): Record<string, unknown> {
  return {
    contents: [{ role: 'user', parts: [{ text: [
      'Explain a deterministic scraper regression and improve the supplied recovery prompt.',
      'Do not claim success, do not make a release decision, and return only JSON matching the schema.',
      `Baseline version: ${input.baseline_version}`,
      `Changed version: ${input.changed_version}`,
      `Changed fields: ${input.changed_fields.join(', ')}`,
      `Deterministic recovery prompt: ${input.deterministic_prompt}`,
    ].join('\n') }] }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: responseSchema, temperature: 0 },
  };
}

function parsePayload(payload: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }): RecoveryAdvice {
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini advice response had no text');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Gemini advice was not valid JSON'); }
  return asAdvice(parsed);
}

/** Uses Gemini structured output. No client is created unless an operator supplies a key. */
export class GeminiFailureAdvisor implements FailureAdvisor {
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;
  constructor(private readonly options: GeminiAdvisorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.model = options.model ?? 'gemini-3.1-flash-lite';
  }

  async advise(input: { baseline_version: string; changed_version: string; changed_fields: string[]; deterministic_prompt: string }): Promise<RecoveryAdvice> {
    const endpoint = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`);
    endpoint.searchParams.set('key', this.options.apiKey);
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody(input)),
    });
    if (!response.ok) throw new Error(`Gemini advice failed: HTTP ${response.status}`);
    return parsePayload(await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> });
  }
}

/** Uses the server's Application Default Credentials and the Vertex AI
 * publisher-model endpoint. This is the production path on Google Cloud; no
 * browser key or customer credential is involved. */
export class VertexGeminiFailureAdvisor implements FailureAdvisor {
  private readonly auth: Pick<GoogleAuth, 'request'>;
  private readonly location: string;
  private readonly model: string;
  constructor(private readonly options: VertexGeminiAdvisorOptions) {
    this.location = options.location ?? 'global';
    this.model = options.model ?? 'gemini-3.1-flash-lite';
    this.auth = options.auth ?? new GoogleAuth({ projectId: options.project, scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  }

  async advise(input: { baseline_version: string; changed_version: string; changed_fields: string[]; deterministic_prompt: string }): Promise<RecoveryAdvice> {
    const host = this.location === 'global' ? 'aiplatform.googleapis.com' : `${this.location}-aiplatform.googleapis.com`;
    const model = `projects/${this.options.project}/locations/${this.location}/publishers/google/models/${this.model}`;
    const url = `https://${host}/v1beta1/${model}:generateContent`;
    const response = await this.auth.request<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>({ url, method: 'POST', data: requestBody(input) });
    return parsePayload(response.data);
  }
}
