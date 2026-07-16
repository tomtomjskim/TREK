import userEvent from '@testing-library/user-event';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '../../../tests/helpers/render';
import { resetAllStores } from '../../../tests/helpers/store';
import PoiCategoryPill from './PoiCategoryPill';

function renderCompact(overrides: Partial<React.ComponentProps<typeof PoiCategoryPill>> = {}) {
  const props: React.ComponentProps<typeof PoiCategoryPill> = {
    active: new Set<string>(),
    onToggle: vi.fn(),
    loadingKeys: new Set<string>(),
    errorKeys: new Set<string>(),
    compact: true,
    ...overrides,
  };
  return { ...render(<PoiCategoryPill {...props} />), props };
}

describe('PoiCategoryPill compact mode', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('renders a 44px accessible nearby-search trigger instead of eight inline buttons', () => {
    renderCompact({ active: new Set(['restaurant', 'cafe']) });

    const trigger = screen.getByRole('button', { name: 'Explore places on the map' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveStyle({ width: '44px', height: '44px' });
    expect(screen.queryByRole('button', { name: 'Restaurants' })).not.toBeInTheDocument();
  });

  it('opens a labelled two-column category chooser and toggles a category', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderCompact({ onToggle });

    await user.click(screen.getByRole('button', { name: 'Explore places on the map' }));

    const dialog = screen.getByRole('dialog', { name: 'Explore places on the map' });
    expect(dialog).toHaveAttribute('data-columns', '2');
    const restaurant = within(dialog).getByRole('button', { name: 'Restaurants' });
    expect(restaurant).toHaveAttribute('aria-pressed', 'false');

    await user.click(restaurant);
    expect(onToggle).toHaveBeenCalledWith('restaurant');
  });

  it('keeps loading, active, error, and search-this-area states available in the chooser', async () => {
    const user = userEvent.setup();
    const onSearchArea = vi.fn();
    renderCompact({
      active: new Set(['restaurant', 'cafe']),
      loadingKeys: new Set(['cafe']),
      errorKeys: new Set(['restaurant']),
      moved: true,
      onSearchArea,
    });

    await user.click(screen.getByRole('button', { name: 'Explore places on the map' }));
    const dialog = screen.getByRole('dialog', { name: 'Explore places on the map' });

    expect(within(dialog).getByRole('button', { name: 'Restaurants' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: 'Cafés' })).toHaveAttribute('aria-busy', 'true');
    await user.click(within(dialog).getByRole('button', { name: 'Search this area' }));
    expect(onSearchArea).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    renderCompact();

    const trigger = screen.getByRole('button', { name: 'Explore places on the map' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes when pointer input lands outside the trigger and chooser', async () => {
    const user = userEvent.setup();
    renderCompact();

    await user.click(screen.getByRole('button', { name: 'Explore places on the map' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('PoiCategoryPill wide mode', () => {
  it('preserves the existing hover and focus tooltip for icon-only categories', async () => {
    const user = userEvent.setup();
    render(<PoiCategoryPill active={new Set()} onToggle={vi.fn()} />);

    await user.hover(screen.getByRole('button', { name: 'Restaurants' }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Restaurants');
  });
});
