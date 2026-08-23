import { describe, expect, it, vi } from 'vitest';
import { GeminiFailureAdvisor, VertexGeminiFailureAdvisor } from '../../../src/ai/gemini-advisor.js';

const input = {
  baseline_version: 'v2',
  changed_version: 'v3',
  changed_fields: ['product_code', 'title', 'price'],
  deterministic_prompt: 'Restore only the three moved fields.',
};

describe('GeminiFailureAdvisor', () => {
  it('uses a narrow JSON schema and returns advice without granting promotion authority', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ explanation: 'The anchors moved.', failure_family: 'selector_anchor_moved', heal_prompt: 'Update only the moved selectors.' }) }] } }],
    }), { status: 200 }));
    const advisor = new GeminiFailureAdvisor({ apiKey: 'test-key', fetchImpl });

    await expect(advisor.advise(input)).resolves.toEqual({ explanation: 'The anchors moved.', failure_family: 'selector_anchor_moved', heal_prompt: 'Update only the moved selectors.' });
    const [, request] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(String(request.body));
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', temperature: 0 });
    expect(body.generationConfig.responseJsonSchema.required).toEqual(['explanation', 'failure_family', 'heal_prompt']);
  });

  it('rejects malformed model output rather than treating it as evidence', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"explanation":"x"}' }] } }] }), { status: 200 }));
    const advisor = new GeminiFailureAdvisor({ apiKey: 'test-key', fetchImpl });
    await expect(advisor.advise(input)).rejects.toThrow(/did not match the recovery schema/);
  });
});

describe('VertexGeminiFailureAdvisor', () => {
  it('uses Google Cloud identity against the Vertex publisher-model endpoint', async () => {
    const request = vi.fn().mockResolvedValue({ data: {
      candidates: [{ content: { parts: [{ text: JSON.stringify({ explanation: 'The generated anchors moved.', failure_family: 'selector_anchor_moved', heal_prompt: 'Rebind only the generated anchors.' }) }] } }],
    } });
    const advisor = new VertexGeminiFailureAdvisor({ project: 'boss-media-505616', location: 'global', model: 'gemini-3.1-flash-lite', auth: { request } as never });

    await expect(advisor.advise(input)).resolves.toMatchObject({ failure_family: 'selector_anchor_moved' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://aiplatform.googleapis.com/v1beta1/projects/boss-media-505616/locations/global/publishers/google/models/gemini-3.1-flash-lite:generateContent',
      method: 'POST',
    }));
    expect(request.mock.calls[0]?.[0].data.generationConfig).toMatchObject({ responseMimeType: 'application/json', temperature: 0 });
  });
});
