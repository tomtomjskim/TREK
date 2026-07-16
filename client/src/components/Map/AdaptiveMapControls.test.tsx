import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '../../../tests/helpers/render';
import AdaptiveMapControls from './AdaptiveMapControls';
import type { CompassMap } from './MapCompassPill';

const map: CompassMap = {
  getBearing: vi.fn(() => 0),
  on: vi.fn(),
  off: vi.fn(),
  easeTo: vi.fn(),
};

const poi = {
  active: new Set<string>(),
  onToggle: vi.fn(),
  loadingKeys: new Set<string>(),
  errorKeys: new Set<string>(),
  moved: false,
  onSearchArea: vi.fn(),
};

const panels = {
  leftWidth: 340,
  rightWidth: 300,
  leftCollapsed: false,
  rightCollapsed: false,
};

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

describe('AdaptiveMapControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewport(884);
  });

  it('uses a compact touch-sized row in an unfolded Fold-width corridor', () => {
    render(<AdaptiveMapControls {...panels} poiEnabled poi={poi} map={map} />);

    const controls = screen.getByTestId('adaptive-map-controls');
    expect(controls).toHaveAttribute('data-layout-mode', 'compact');
    expect(controls).toHaveStyle({ left: '462px', top: '14px', flexDirection: 'row' });
    expect(screen.getByRole('button', { name: 'Explore places on the map' })).toHaveStyle({
      width: '44px',
      height: '44px',
    });
    expect(screen.getByRole('button', { name: 'Reset north' })).toHaveStyle({ width: '44px', height: '44px' });
  });

  it('keeps the existing wide category row when the free corridor can hold it', () => {
    setViewport(1280);
    render(<AdaptiveMapControls {...panels} poiEnabled poi={poi} map={map} />);

    const controls = screen.getByTestId('adaptive-map-controls');
    expect(controls).toHaveAttribute('data-layout-mode', 'wide');
    expect(controls).toHaveStyle({ left: '660px', top: '14px', flexDirection: 'row' });
    expect(screen.getByRole('button', { name: 'Restaurants' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset north' })).toHaveStyle({ width: '34px', height: '34px' });
  });

  it('responds to viewport resize and stacks controls below the panel toggles', () => {
    setViewport(1280);
    render(<AdaptiveMapControls {...panels} poiEnabled poi={poi} map={map} />);
    expect(screen.getByTestId('adaptive-map-controls')).toHaveAttribute('data-layout-mode', 'wide');

    setViewport(800);
    fireEvent(window, new Event('resize'));

    const controls = screen.getByTestId('adaptive-map-controls');
    expect(controls).toHaveAttribute('data-layout-mode', 'stacked');
    expect(controls).toHaveStyle({ left: '420px', top: '76px', flexDirection: 'column' });
  });

  it('recomputes from persisted panel widths without requiring a viewport resize', () => {
    setViewport(1280);
    const { rerender } = render(<AdaptiveMapControls {...panels} poiEnabled poi={poi} map={map} />);
    expect(screen.getByTestId('adaptive-map-controls')).toHaveAttribute('data-layout-mode', 'wide');

    rerender(<AdaptiveMapControls {...panels} leftWidth={520} rightWidth={520} poiEnabled poi={poi} map={map} />);
    expect(screen.getByTestId('adaptive-map-controls')).toHaveAttribute('data-layout-mode', 'compact');
  });

  it('renders nothing when both POI exploration and compass are unavailable', () => {
    render(<AdaptiveMapControls {...panels} poiEnabled={false} poi={poi} map={null} />);
    expect(screen.queryByTestId('adaptive-map-controls')).not.toBeInTheDocument();
  });
});
