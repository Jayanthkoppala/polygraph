import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Footer } from '@/landing/sections/Footer';

describe('Footer', () => {
  it('links every public truth and legal destination to a real route', () => {
    render(<Footer />);

    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/Jayanthkoppala/polygraph',
    );
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/legal/privacy');
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal/terms');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });
});
