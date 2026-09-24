import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Logo } from '@/components/Logo';

describe('<Logo />', () => {
  it('is decorative, themed via currentColor and the accent token, and accepts a class', () => {
    const { container } = render(<Logo className="size-5" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('viewBox')).toBe('0 0 64 64');
    expect(svg.classList.contains('size-5')).toBe(true);
    expect(svg.querySelector('polygon')!.getAttribute('stroke')).toBe('currentColor');
    expect(svg.querySelector('ellipse')!.classList.contains('stroke-accent')).toBe(true);
    expect(svg.querySelector('circle')!.classList.contains('fill-accent')).toBe(true);
  });
});
