import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReceiptsPage } from '@/receipts/ReceiptsPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReceiptsPage', () => {
  it('renders only the broken repair data returned by the receipt API', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).split('?')[0];
      if (path === '/api/receipts') return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: 'authentication required' }),
      };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
        receipts: [{
          id: 'mission-42',
          source: 'demo',
          collector: 'c_products',
          collector_name: 'Daily products',
          incident_run_id: 'run-b',
          heal_job_id: 'heal-1',
          detected_at: '2026-08-22T10:00:00.000Z',
          repair_started_at: '2026-08-22T10:01:00.000Z',
          completed_at: '2026-08-22T10:03:00.000Z',
          status: 'verified',
          cause: 'STRUCTURAL',
          incident_verdict: 'FAILED_STRUCTURAL',
          changed_fields: ['price', 'title'],
          change_summary: 'price and title disappeared after markup moved',
          repair_prompt: 'Restore price and title extraction.',
          proof_run_id: 'run-c',
          terminal_ledger_id: null,
          event_hash: null,
        }],
        }),
      };
    }));

    render(<MemoryRouter><ReceiptsPage /></MemoryRouter>);

    expect(await screen.findByRole('table', { name: /repair receipts/i })).toBeInTheDocument();
    expect(screen.getByText('Daily products')).toBeInTheDocument();
    expect(screen.getByText('price and title disappeared after markup moved')).toBeInTheDocument();
    expect(screen.getByText('Restore price and title extraction.')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('price')).toBeInTheDocument();
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText(/live mission evidence/i)).toBeInTheDocument();
  });

  it('shows ten newest receipts per page and pages through the remainder', async () => {
    const receipts = Array.from({ length: 12 }, (_, index) => ({
      id: `mission-${index + 1}`,
      source: 'demo',
      collector: `c_${index + 1}`,
      collector_name: `Collector ${String(index + 1).padStart(2, '0')}`,
      incident_run_id: `run-b-${index + 1}`,
      heal_job_id: `heal-${index + 1}`,
      detected_at: `2026-08-22T10:${String(index).padStart(2, '0')}:00.000Z`,
      repair_started_at: `2026-08-22T10:${String(index).padStart(2, '0')}:10.000Z`,
      completed_at: `2026-08-22T10:${String(index).padStart(2, '0')}:30.000Z`,
      status: 'verified',
      cause: 'STRUCTURAL',
      incident_verdict: 'FAILED_STRUCTURAL',
      changed_fields: ['price'],
      change_summary: 'price selector moved',
      repair_prompt: 'Restore price extraction.',
      proof_run_id: `run-c-${index + 1}`,
      terminal_ledger_id: null,
      event_hash: null,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).split('?')[0];
      if (path === '/api/receipts') return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: 'authentication required' }),
      };
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ receipts }) };
    }));

    render(<MemoryRouter><ReceiptsPage /></MemoryRouter>);

    expect(await screen.findByText('Collector 12')).toBeInTheDocument();
    expect(screen.getByText('1–10 of 12 receipts · 10 per page')).toBeInTheDocument();
    expect(screen.queryByText('Collector 02')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /next receipts page/i }));

    expect(screen.getByText('Collector 02')).toBeInTheDocument();
    expect(screen.getByText('11–12 of 12 receipts · 10 per page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next receipts page/i })).toBeDisabled();
  });
});
